import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import createUserAgentOverride from 'puppeteer-extra-plugin-stealth/evasions/user-agent-override/index.js';

// The stealth plugin's user-agent evasion sends Network.setUserAgentOverride on
// every new page without awaiting or catching it. When a tab closes before
// Chrome answers (an official-posting page read closing its context, a site
// closing a popup), that promise rejects with TargetCloseError and reaches the
// process-wide unhandledRejection handler as an ERROR. This keeps the evasion
// and the exact override it sends, and only gives that one send a handler.
const UserAgentOverride = Object.getPrototypeOf(createUserAgentOverride()).constructor;

export function isTargetClosedError(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`;
  return /TargetCloseError|Target closed|Session closed|has been closed|detached/iu.test(text);
}

function guardedClient(client, onSendError) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'send') {
        return (method, ...rest) => {
          const sent = target.send(method, ...rest);
          if (method === 'Network.setUserAgentOverride' && sent && typeof sent.catch === 'function') {
            sent.catch(error => onSendError(error));
          }
          return sent;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function guardedPage(page, onSendError) {
  return new Proxy(page, {
    get(target, prop) {
      if (prop === '_client') {
        const raw = target._client;
        const client = typeof raw === 'function' ? raw.call(target) : raw;
        const guarded = guardedClient(client, onSendError);
        return typeof raw === 'function' ? () => guarded : guarded;
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export class GuardedUserAgentOverride extends UserAgentOverride {
  constructor(opts = {}, { onUnexpectedError = () => {} } = {}) {
    super(opts);
    this._onSendError = (error) => {
      if (isTargetClosedError(error)) return;
      onUnexpectedError(error);
    };
  }

  async onPageCreated(page) {
    return super.onPageCreated(guardedPage(page, this._onSendError));
  }
}

/** Stealth evasions with the user-agent override's floating send given a handler. */
export function createStealthPlugins({ onUnexpectedError } = {}) {
  const stealth = StealthPlugin();
  stealth.enabledEvasions.delete('user-agent-override');
  return [stealth, new GuardedUserAgentOverride({}, { onUnexpectedError })];
}
