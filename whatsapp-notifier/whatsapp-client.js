const { execFileSync } = require('child_process');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const GROUP_NAME = process.env.WHATSAPP_GROUP_NAME || 'Semi-kooks';
const CONFIGURED_GROUP_ID = process.env.WHATSAPP_GROUP_ID
  ? process.env.WHATSAPP_GROUP_ID.trim()
  : null;
const INVITE_CODE = (() => {
  const value = process.env.WHATSAPP_GROUP_INVITE_CODE || '';
  if (!value) return null;
  const match =
    value.trim().match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)$/) ||
    value.trim().match(/^([A-Za-z0-9]+)$/);
  return match ? match[1] : value.trim();
})();
const INIT_TIMEOUT_MS = Number(process.env.WHATSAPP_INIT_TIMEOUT_MS || 900000);
const QR_WAIT_MS = Number(process.env.WHATSAPP_QR_WAIT_MS || 600000);
const READY_FALLBACK_MS = Number(process.env.WHATSAPP_READY_FALLBACK_MS || 180000);
// Optional pin. Default is unset so whatsapp-web.js can use a current
// WhatsApp Web build. Pinning an old HTML made `ready` fire but broke
// getChats/getChatById/sendMessage (they throw a minified "r" error).
const WEB_VERSION = process.env.WHATSAPP_WEB_VERSION || null;
const WEB_VERSION_CACHE_PATH =
  process.env.WHATSAPP_WEB_VERSION_CACHE_PATH || '/app/wa-version-cache';
// Linked account's number in international format, digits only (e.g. 61412345678).
// When set, linking uses an 8-character pairing code instead of a QR scan.
const PAIRING_PHONE = (process.env.WHATSAPP_PAIRING_PHONE || '').replace(/\D/g, '');
// Linking is only attempted before this ISO timestamp. Scheduled runs without
// a valid session otherwise send a "link a new device" prompt to the phone
// every cycle, with nobody there to enter the code.
const LINK_UNTIL = Date.parse(process.env.WHATSAPP_LINK_UNTIL || '');

function isLinkingAllowed() {
  return Number.isFinite(LINK_UNTIL) && Date.now() < LINK_UNTIL;
}

// whatsapp-web.js defaults to a Chrome 101 user agent, which WhatsApp can
// reject during device linking. Advertise the real Chromium major version.
function getUserAgent() {
  if (process.env.WHATSAPP_USER_AGENT) return process.env.WHATSAPP_USER_AGENT;
  const executable = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (!executable) return undefined;
  try {
    const output = execFileSync(executable, ['--version'], { encoding: 'utf8' });
    const major = output.match(/(\d+)\.\d+\.\d+\.\d+/)?.[1];
    if (!major) return undefined;
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  } catch (err) {
    console.warn('Could not detect Chromium version for user agent:', err.message);
    return undefined;
  }
}

function getPuppeteerOptions() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-first-run',
    '--disable-extensions',
    '--no-zygote',
    '--disable-accelerated-2d-canvas',
  ];

  const options = {
    protocolTimeout: 300000,
    headless: true,
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    options.args = args;
  }

  return options;
}

let resolvedGroupId = null;

async function dumpStoreGroups(client) {
  try {
    const snapshot = await client.pupPage.evaluate(() => {
      let chats = [];
      try {
        chats = window.require('WAWebCollections').Chat.getModelsArray() || [];
      } catch (_) {
        chats = [];
      }
      return {
        hasWWebJS: !!window.WWebJS,
        chatCount: chats.length,
        chats: chats.slice(0, 40).map((chat) => ({
          name: chat.name || chat.formattedTitle || '',
          id: chat.id?._serialized || chat.id?.$1 || String(chat.id || ''),
          isGroup: !!(
            chat.isGroup ||
            chat.groupMetadata ||
            String(chat.id?._serialized || chat.id?.$1 || '').endsWith('@g.us')
          ),
        })),
      };
    });
    console.log('WhatsApp chat snapshot:', JSON.stringify(snapshot));
    return snapshot.chats.filter((chat) => chat.isGroup);
  } catch (err) {
    console.warn('WhatsApp chat dump failed:', err.message);
    return [];
  }
}

async function fetchGroupsWithRetry(client, attempt = 1, maxAttempts = 3) {
  try {
    return await client.getChats();
  } catch (err) {
    const isTimeout = (err.message || '').includes('timed out');
    if (isTimeout && attempt < maxAttempts) {
      console.log(`getChats timeout, retrying in 10s (attempt ${attempt}/${maxAttempts})...`);
      await new Promise((resolve) => setTimeout(resolve, 10000));
      return fetchGroupsWithRetry(client, attempt + 1, maxAttempts);
    }
    throw err;
  }
}

async function resolveTargetGroup(client) {
  const targetName = GROUP_NAME.trim().toLowerCase();

  try {
    const chats = await fetchGroupsWithRetry(client);
    const group = chats.find(
      (chat) =>
        chat.isGroup && chat.name && chat.name.trim().toLowerCase() === targetName
    );

    if (group) {
      resolvedGroupId = group.id._serialized;
      console.log(`Resolved group "${group.name}" -> ${resolvedGroupId}`);
      return resolvedGroupId;
    }

    const groupNames = chats.filter((chat) => chat.isGroup).map((chat) => chat.name);
    console.warn(`Group "${GROUP_NAME}" not found by name. Available groups:`, groupNames.join(', ') || '(none)');
  } catch (err) {
    console.warn('Group lookup by name failed:', err.message);
  }

  const storeGroups = await dumpStoreGroups(client);
  const storeMatch = storeGroups.find(
    (group) => group.name && group.name.trim().toLowerCase() === targetName
  );
  if (storeMatch?.id) {
    resolvedGroupId = storeMatch.id;
    console.log(`Resolved group from WhatsApp Store "${storeMatch.name}" -> ${resolvedGroupId}`);
    return resolvedGroupId;
  }

  if (INVITE_CODE) {
    try {
      const groupId = await client.acceptInvite(INVITE_CODE);
      if (groupId) {
        resolvedGroupId = groupId;
        console.log(`Resolved group from invite code: ${resolvedGroupId}`);
        return resolvedGroupId;
      }
    } catch (err) {
      console.warn('Invite lookup failed (may already be in group):', err.message);
    }
  }

  if (CONFIGURED_GROUP_ID) {
    resolvedGroupId = CONFIGURED_GROUP_ID;
    console.warn(`Using configured group ID fallback: ${resolvedGroupId}`);
    return resolvedGroupId;
  }

  throw new Error(`Group "${GROUP_NAME}" could not be resolved`);
}

async function createAndInitializeClient() {
  return new Promise((resolve, reject) => {
    const clientOptions = {
      puppeteer: getPuppeteerOptions(),
      authStrategy: new LocalAuth({
        dataPath: process.env.WHATSAPP_AUTH_PATH || '/data/.wwebjs_auth',
      }),
      // WhatsApp Web sync after QR can take several minutes on a cold session.
      authTimeoutMs: Number(process.env.WHATSAPP_AUTH_TIMEOUT_MS || 900000),
    };
    if (WEB_VERSION) {
      clientOptions.webVersion = WEB_VERSION;
      clientOptions.webVersionCache = {
        type: 'local',
        path: WEB_VERSION_CACHE_PATH,
      };
    }
    const userAgent = getUserAgent();
    if (userAgent) {
      clientOptions.userAgent = userAgent;
      console.log(`Using browser user agent: ${userAgent}`);
    }
    const linkingAllowed = isLinkingAllowed();
    if (PAIRING_PHONE && linkingAllowed) {
      clientOptions.pairWithPhoneNumber = {
        phoneNumber: PAIRING_PHONE,
        showNotification: true,
        intervalMs: 180000,
      };
      console.log(`Device linking via pairing code for number ending ${PAIRING_PHONE.slice(-3)}`);
    }
    const client = new Client(clientOptions);

    let settled = false;
    let timeout = null;
    let loadingPercent = 0;
    let loadingComplete = false;
    let isAuthenticated = false;
    let readyFallbackTimer = null;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (readyFallbackTimer) clearTimeout(readyFallbackTimer);
      fn(value);
    };

    let initStarted = false;
    const completeInit = async (label) => {
      if (initStarted || settled) return;
      initStarted = true;
      if (readyFallbackTimer) clearTimeout(readyFallbackTimer);
      console.log(`WhatsApp init complete (${label})`);
      try {
        await waitForChatSync();
        await resolveTargetGroup(client);
        finish(resolve, client);
      } catch (err) {
        finish(reject, err);
      }
    };

    const scheduleReadyFallback = () => {
      if (readyFallbackTimer) clearTimeout(readyFallbackTimer);
      readyFallbackTimer = setTimeout(async () => {
        if (settled) return;
        try {
          const state = await client.getState();
          console.log(`Ready fallback check: state=${state}, loading=${loadingPercent}%`);
          if (state === 'CONNECTED') {
            await completeInit('CONNECTED fallback after auth');
          }
        } catch (err) {
          console.warn('Ready fallback check failed:', err.message);
        }
      }, READY_FALLBACK_MS);
    };

    const armTimeout = (ms, label) => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        finish(reject, new Error(`WhatsApp client init timed out after ${ms}ms (${label})`));
      }, ms);
    };

    const waitForChatSync = async () => {
      // `ready` can fire while the loading screen is still at a few percent.
      // Sending before chats finish syncing returns empty message objects and
      // nothing appears in the group.
      const deadline = Date.now() + 120000;
      while (!loadingComplete && Date.now() < deadline) {
        console.log(`Waiting for WhatsApp chat sync (loading=${loadingPercent}%)...`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!loadingComplete) {
        console.warn('Loading screen never reached 99%+; continuing anyway after wait.');
      } else {
        // Extra settle time after load before chat store APIs are reliable.
        await new Promise((r) => setTimeout(r, 15000));
      }
      try {
        const info = client.info || {};
        console.log(
          'WhatsApp session info:',
          JSON.stringify({
            pushname: info.pushname,
            wid: info.wid?._serialized || info.wid,
            platform: info.platform,
          })
        );
        console.log('WhatsApp state:', await client.getState());
      } catch (err) {
        console.warn('Could not read WhatsApp session info:', err.message);
      }
    };

    armTimeout(INIT_TIMEOUT_MS, 'waiting for ready');

    // whatsapp-web.js can reject with a bare "auth timeout" string.
    process.once('unhandledRejection', (reason) => {
      const message = typeof reason === 'string' ? reason : reason?.message || String(reason);
      if (message.includes('auth timeout') || message.includes('ready timeout')) {
        finish(reject, new Error(message));
      }
    });

    client.on('qr', (qr) => {
      if (!linkingAllowed) {
        finish(
          reject,
          new Error(
            'WhatsApp is not linked (session missing or logged out). Relink by setting WHATSAPP_LINK_UNTIL on the machine and starting it.'
          )
        );
        return;
      }
      console.log('QR Code received, scan with your phone:');
      console.log(`Waiting up to ${Math.round(QR_WAIT_MS / 1000)}s for you to scan before this run exits.`);
      qrcode.generate(qr, { small: true });
      // Give enough time to open WhatsApp and scan from the logs.
      armTimeout(QR_WAIT_MS, 'waiting for QR scan');
    });

    client.on('code', (code) => {
      const formatted = String(code).replace(/^(.{4})(.{4})$/, '$1-$2');
      console.log(`WhatsApp pairing code: ${formatted}`);
      console.log(
        'On your phone: WhatsApp > Settings > Linked devices > Link a device > "Link with phone number instead", then enter the code.'
      );
      armTimeout(QR_WAIT_MS, 'waiting for pairing code entry');
    });

    client.on('loading_screen', (percent, message) => {
      loadingPercent = Number(percent) || 0;
      // WhatsApp often stalls at 99% and never emits 100.
      if (loadingPercent >= 99) loadingComplete = true;
      console.log('WhatsApp loading screen:', { percent, message });
    });

    client.on('authenticated', () => {
      console.log('WhatsApp authenticated (session restored or QR scan accepted)');
      isAuthenticated = true;
      // After scan, sync/load can take a long time — keep waiting for ready.
      armTimeout(INIT_TIMEOUT_MS, 'waiting for ready after auth');
      scheduleReadyFallback();
    });

    client.on('ready', async () => {
      console.log('WhatsApp client is ready');
      await completeInit('ready event');
    });

    client.on('auth_failure', (msg) => {
      finish(reject, new Error(`WhatsApp auth failure: ${msg}`));
    });

    client.on('disconnected', (reason) => {
      // Before auth, whatsapp-web.js recovers from LOGOUT by clearing the
      // session and re-injecting, which produces a fresh QR / pairing code.
      if (reason === 'LOGOUT' && !isAuthenticated) {
        console.warn(
          'WhatsApp logged out before linking finished (link rejected or expired). Waiting for a fresh QR / pairing code...'
        );
        armTimeout(QR_WAIT_MS, 'waiting for new link after LOGOUT');
        return;
      }
      finish(reject, new Error(`WhatsApp disconnected during init: ${reason}`));
    });

    client.initialize().catch((err) => {
      finish(reject, err);
    });
  });
}

async function waitForServerAck(client, sentMessage, timeoutMs = 45000) {
  if (!sentMessage?.id?._serialized) {
    throw new Error('sendMessage returned no message id — delivery not confirmed');
  }
  if (typeof sentMessage.ack === 'number' && sentMessage.ack >= 1) {
    console.log(`Message already ACKed (ack=${sentMessage.ack})`);
    return;
  }

  const messageId = sentMessage.id._serialized;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.removeListener('message_ack', onAck);
      reject(new Error(`Timed out waiting for WhatsApp server ACK for ${messageId}`));
    }, timeoutMs);

    function onAck(msg, ack) {
      if (msg?.id?._serialized !== messageId) return;
      console.log(`Message ACK update: ${ack}`);
      if (ack >= 1) {
        clearTimeout(timer);
        client.removeListener('message_ack', onAck);
        resolve();
      }
    }

    client.on('message_ack', onAck);
  });
}

// WhatsApp Web sometimes reloads itself (commonly a few minutes after a new
// device link). The library re-injects its helpers after the reload; calls
// made in between fail with "window.require is not a function" or
// "Cannot read properties of undefined". Wait for the page to be usable.
async function waitForPageInjected(client, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let warned = false;
  while (Date.now() < deadline) {
    try {
      const ready = await client.pupPage.evaluate(
        () =>
          typeof window.require === 'function' &&
          typeof window.WWebJS !== 'undefined' &&
          !!window.require('WAWebCollections')?.Chat
      );
      if (ready) {
        if (warned) console.log('WhatsApp page is usable again after reload.');
        return;
      }
    } catch (_) {
      // Execution context destroyed mid-navigation; retry.
    }
    if (!warned) {
      console.warn('WhatsApp page reloaded; waiting for it to finish loading...');
      warned = true;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('WhatsApp page did not finish reloading in time');
}

async function sendMessage(client, message) {
  await waitForPageInjected(client);
  if (!resolvedGroupId) {
    await resolveTargetGroup(client);
  }
  if (!resolvedGroupId) {
    throw new Error('WhatsApp target group is not configured or could not be resolved');
  }

  // Confirm the chat exists and log its name so we know where we're posting.
  let chatLoaded = false;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const chat = await client.getChatById(resolvedGroupId);
      console.log(
        `Target chat: name="${chat?.name || '(unknown)'}" isGroup=${!!chat?.isGroup} id=${resolvedGroupId}`
      );
      chatLoaded = true;
      break;
    } catch (err) {
      console.warn(`getChatById attempt ${attempt}/5 failed: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
      await waitForPageInjected(client);
    }
  }
  if (!chatLoaded) {
    throw new Error(
      `Could not load WhatsApp chat ${resolvedGroupId}. Linked account may not be in the group, or chats are still syncing.`
    );
  }

  console.log(`Sending message to group ${resolvedGroupId}`);
  // waitUntilMsgSent waits for WhatsApp server acceptance. Without this,
  // sendMessage can resolve after only writing to the local store — and then
  // destroy() kills Chromium before the message ever leaves the machine.
  const sent = await client.sendMessage(resolvedGroupId, message, {
    sendSeen: false,
    waitUntilMsgSent: true,
  });
  console.log(
    `sendMessage returned id=${sent?.id?._serialized || '(none)'} ack=${sent?.ack ?? 'n/a'}`
  );
  if (!sent?.id?._serialized) {
    throw new Error('sendMessage returned no message id — treating as failed delivery');
  }
  await waitForServerAck(client, sent);
}

async function destroyClient(client) {
  if (!client) return;
  // Brief settle so any in-flight sync finishes before Chromium is killed.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    await client.destroy();
  } catch (err) {
    console.warn('Error destroying WhatsApp client:', err.message);
  }
}

module.exports = {
  createAndInitializeClient,
  sendMessage,
  destroyClient,
  resolveTargetGroup,
};
