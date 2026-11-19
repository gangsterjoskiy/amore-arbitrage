# A|More Arbitrage

Telegram-бот для мониторинга межбиржевых расхождений цен на спотовых USDT-парах. Первая версия использует публичные котировки Binance, Bybit и OKX. Автоматическая торговля и API-ключи бирж не используются.

## Возможности MVP

- Сравнение ask покупки и bid продажи на разных биржах.
- Расчётный спред после taker-комиссий обеих сторон.
- Фильтр по глубине лучшей цены.
- До 8 лучших результатов в Telegram.
- Команды /start, /scan, /subscribe, /unsubscribe, /help.
- Периодические сигналы через Cloudflare Cron и KV с защитой от повторов на 5 минут.
- Нет API-ключей бирж и функций размещения ордеров.

## Ограничения

Положительный расчётный спред не означает гарантированную прибыль. Первая версия не моделирует комиссии и сроки вывода, доступность сетей, проскальзывание, исполнение полного объёма, изменение цены между проверкой и сделкой, индивидуальные тарифы и региональные ограничения. Это мониторинг для бумажного тестирования, а не торговая рекомендация.

## Развёртывание на Cloudflare Workers

1. Создай KV namespace с именем SUBSCRIBERS в Cloudflare.
2. Скопируй его ID и замени REPLACE_WITH_KV_NAMESPACE_ID в wrangler.toml.
3. Разверни Worker из репозитория.
4. В настройках Worker добавь Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET и WEBHOOK_PATH_SECRET. Используй отдельные случайные строки для двух последних секретов.
5. Необязательные Variables (значения комиссий в процентах): BINANCE_TAKER_FEE, BYBIT_TAKER_FEE, OKX_TAKER_FEE (по умолчанию 0.1); MIN_NET_SPREAD_PERCENT (0.25); MIN_TOP_OF_BOOK_DEPTH_USDT (25). Значение 0.1 означает 0,1%. Укажи реальные тарифы своего аккаунта перед тестированием.
6. Установи webhook запросом к Telegram Bot API, подставив свои значения (токен не публикуй):

   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://<WORKER>.workers.dev/telegram/<WEBHOOK_PATH_SECRET>" -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"

7. Отправь боту /start, затем /scan.

## Проверка

GET /health возвращает JSON с ok: true. Команда /scan получает публичные котировки в момент запроса. npm run check проверяет синтаксис JavaScript.
