# Frontend Integration Notes (Lovable)

## Auth – Login (email + password only)

**Login:** `POST /api/auth/login` with body `{ email, password }` only. Company ID is not required.

**Response:**
```json
{
  "token": "jwt...",
  "user": { "id": "...", "email": "...", "role": "...", "companyId": "..." },
  "company": { "id": "...", "name": "..." }
}
```

**Authenticate:** Send `Authorization: Bearer <token>` on all API requests. The `x-company-id` header is optional; tenant is derived from the JWT. If you send `x-company-id`, it must match the user's company or you get 403.

---

## A) Inbox – Status Filter & Lead Status Dropdown

### Status filter dropdown

1. **Fetch statuses:** `GET /api/leads/statuses`
   - Response: `{ statuses: [{ id, name, position }, ...] }`
   - Normalize: `const list = Array.isArray(res?.statuses) ? res.statuses : []`

2. **Build options:**
   - First option: **"New"** (default) — use the status with `position === 0` or `is_default`, or the first in the list. If none, use first status.
   - Then: one option per status (by `name`), ordered by `position` asc.
   - Last option: **"All statuses"** with value `__ALL__`.

3. **Request leads:**
   - When filter = `__ALL__` → `GET /api/leads?limit=50&offset=0` (no `status_id` param).
   - When filter = UUID → `GET /api/leads?status_id=<uuid>&limit=50&offset=0`.

4. **Avoid `.map is not a function`:** Always normalize:
   ```js
   const leads = Array.isArray(res?.leads) ? res.leads : [];
   const statuses = Array.isArray(res?.statuses) ? res.statuses : [];
   ```

5. **Lead list response** already includes `status_id` and `status_name` per row — no extra lookup needed.

### Per-row status dropdown

- Options: all statuses from `GET /api/leads/statuses`.
- On change: `PATCH /api/leads/:leadId/status` with `{ status_id: "<uuid>" }`.
- Update local state or refetch the list after success.

---

## B) Conversation – Manual vs Automated Testing

### Mode toggle

- **Manual testing** (default): User messages only stored; AI reply only when user clicks "AI Reply".
- **Automated testing**: After user message, start delay timer; when it ends, call AI reply once.

### Manual flow

1. User types message → `POST /api/companies/:companyId/leads/:leadId/messages` with `{ role: "user", content }`.
2. Response: `{ ok: true, lead_id, conversation_id, messages }` — append user message to UI.
3. User clicks "AI Reply" → `POST /api/companies/:companyId/leads/:leadId/ai-reply`.
4. Response: `{ assistant_message, conversation_id, looking_for, collected, messages }` — append assistant message.

### Automated flow

1. User types message → same `POST .../messages` as above.
2. Start countdown timer (default 8s, configurable 1–120s).
3. If user sends another message before timer ends → reset timer.
4. When timer ends → call `POST .../ai-reply` once.
5. Optional UI: show "Replying in Xs" while countdown.
6. **Concurrency:** If AI reply is in-flight and user sends more messages, schedule another reply after delay when the current one completes (don’t call AI twice at once).

### API contracts

- **POST .../messages** — stores message only; no AI.
- **POST .../ai-reply** — generates assistant reply, persists it, returns `assistant_message`, `looking_for`, `collected`, `messages`.

---

## C) Settings – Account Management

### Endpoints

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/api/me` | — | `{ id, email, company_id }` |
| PUT | `/api/me/email` | `{ email }` | `{ ok: true, email }` |
| PUT | `/api/me/password` | `{ current_password, new_password }` | `{ ok: true }` |

### UI

1. **Update email:** Input + Save. On success → toast; optionally refresh `/api/me`.
2. **Change password:** Current password, new password, confirm new password. Validate match before submit. On success → toast.
3. Show success/error toasts for all operations.

### Error handling

- `400`: Validation (e.g. invalid email, password too short).
- `401`: Wrong current password.
- `409`: Email already in use.
