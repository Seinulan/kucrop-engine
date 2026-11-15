-- Вход через Google и Facebook, подтверждение почты и сброс пароля.

-- У аккаунта, созданного через Google или Facebook, пароля нет.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- Когда владелец подтвердил, что почта его (ссылка из письма или вход через Google). NULL = не подтверждена.
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
-- Аккаунты, созданные до появления подтверждения, считаются подтверждёнными: иначе их владельцы не смогли бы войти.
UPDATE users SET email_verified_at = created_at;

-- Привязка аккаунта к внешнему входу: один внешний аккаунт - один пользователь KUCrop.
CREATE TABLE oauth_accounts (
    provider         TEXT        NOT NULL CHECK (provider IN ('google', 'facebook')),
    provider_user_id TEXT        NOT NULL CHECK (char_length(provider_user_id) BETWEEN 1 AND 255),
    user_id          BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    email            TEXT        NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX oauth_accounts_user_id_idx ON oauth_accounts (user_id);

-- Одноразовые ссылки из писем: подтверждение почты и сброс пароля. В базе лежит только SHA-256 токена.
CREATE TABLE email_tokens (
    token_hash TEXT        PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose    TEXT        NOT NULL CHECK (purpose IN ('verify', 'reset')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX email_tokens_user_purpose_idx ON email_tokens (user_id, purpose);
