-- V3 engine: explicit manual-handoff delivery state (e.g. TikTok "sent to creator inbox"): the provider holds
-- a draft that a person must finish in the native app. Not published, not ambiguous, not failed.
ALTER TYPE delivery_state ADD VALUE IF NOT EXISTS 'handoff';
