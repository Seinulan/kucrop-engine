-- KUCrop: пользователи, сессии, файлы AquaCrop и история расчётов.
-- Миграции применяются автоматически при старте сервера (src/db.js), по одному разу, по порядку имён.

CREATE TABLE users (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email         TEXT        NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
    name          TEXT        NOT NULL DEFAULT '' CHECK (char_length(name) <= 80),
    password_hash TEXT        NOT NULL,               -- scrypt: соль и хеш, сам пароль не хранится
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- один аккаунт на адрес почты, без учёта регистра
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE sessions (
    token_hash TEXT        PRIMARY KEY,               -- SHA-256 от токена из cookie; сам токен в базе не лежит
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Файлы AquaCrop пользователя (.CLI .Tnx .ETo .PLU .CRO .SOL .GWT .MAN). Встроенные файлы примера лежат в коде, не в базе.
CREATE TABLE files (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    kind       TEXT        NOT NULL CHECK (kind IN ('cli', 'tnx', 'eto', 'plu', 'cro', 'sol', 'gwt', 'man')),
    content    BYTEA       NOT NULL,
    size_bytes INTEGER     NOT NULL CHECK (size_bytes BETWEEN 1 AND 2097152),
    sha256     TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- имя файла уникально у пользователя без учёта регистра (как в Windows, откуда приходят файлы AquaCrop)
CREATE UNIQUE INDEX files_user_name_key ON files (user_id, lower(name));

-- История расчётов: параметры запроса и полный результат, чтобы расчёт можно было открыть снова.
CREATE TABLE simulations (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT       NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    params_hash   TEXT         NOT NULL,              -- одинаковый сценарий подряд не дублируется
    params        JSONB        NOT NULL,              -- выбранные файлы и условия расчёта
    station       TEXT         NOT NULL DEFAULT '',
    crop          TEXT         NOT NULL DEFAULT '',
    start_date    DATE         NOT NULL,
    season_year   INTEGER      NOT NULL,
    irrigated     BOOLEAN      NOT NULL DEFAULT false,
    yield_t_ha    NUMERIC(8,3) NOT NULL CHECK (yield_t_ha >= 0),
    ai_yield_t_ha NUMERIC(8,3) CHECK (ai_yield_t_ha >= 0),   -- NULL, если ИИ к сценарию не применим
    result        JSONB        NOT NULL
);
CREATE INDEX simulations_user_created_idx ON simulations (user_id, created_at DESC);
