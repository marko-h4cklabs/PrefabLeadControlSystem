-- Allow null password_hash for Google OAuth users who sign up without a password
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
