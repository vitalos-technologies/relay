// Telegram provider: publishing adapter, channel connector and simulated API.
export { telegramAdapter, TELEGRAM_CONSTRAINTS, TELEGRAM_CONSTRAINTS_VERSION, telegramMessageUrl } from './adapter.js';
export { telegramConnector, TelegramSetupError, parseChannelInput } from './connector.js';
export { telegramFake, FAKE_BOT as TELEGRAM_FAKE_BOT } from './fake.js';
export { TelegramApiError, classifyTelegramError, sanitizeTelegramText } from './api.js';
