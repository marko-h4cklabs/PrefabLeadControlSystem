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

---

## D) Picture Attachments (pictures quote preset)

When the **pictures** quote preset is enabled for a company, the chat accepts image uploads and stores them as collected info.

### Upload endpoint

- **POST** `/api/leads/:leadId/attachments` (flat route)
- **POST** `/api/companies/:companyId/leads/:leadId/attachments` (companies route)

**Request:** `multipart/form-data` with field `file` (image file).

**Constraints:**
- Only images: `mime` must start with `image/` (e.g. `image/jpeg`, `image/png`)
- Max size: 5MB

**Response (201):**
```json
{
  "attachment_id": "uuid",
  "url": "https://<backend>/public/attachments/<id>/<public_token>",
  "mime_type": "image/jpeg",
  "file_name": "photo.jpg"
}
```

**Frontend upload example:**
```js
const formData = new FormData();
formData.append('file', fileInput.files[0]);

const res = await fetch(`/api/leads/${leadId}/attachments`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: formData,
});
const { url } = await res.json();
```

### Public image URL (no auth)

- **GET** `/public/attachments/:id/:token`

Use the `url` from the upload response. It works without JWT and can be:
- Opened in a browser
- Embedded in `<img src="...">` tags for preview

### Display in collected info

When pictures preset is enabled and attachments exist, `collected_infos` (or `collected`) includes:
```json
{
  "name": "pictures",
  "type": "pictures",
  "value": ["https://.../public/attachments/...", "https://.../public/attachments/..."],
  "links": [
    { "label": "Picture 1", "url": "https://..." },
    { "label": "Picture 2", "url": "https://..." }
  ]
}
```

- `value`: array of URLs for thumbnails (`<img src="...">`)
- `links`: array of `{label, url}` for hyperlink rendering

**Thumbnail display:**
```jsx
{collected_infos
  ?.filter(c => c.name === 'pictures' && Array.isArray(c.value))
  ?.flatMap(c => c.value)
  ?.map(url => <img key={url} src={url} alt="Attachment" />)}
```

**Hyperlink display:**
```jsx
{collected_infos
  ?.find(c => c.name === 'pictures')
  ?.links
  ?.map(({ label, url }) => (
    <a key={url} href={url} target="_blank" rel="noopener noreferrer">{label}</a>
  ))}
```

---

## E) In-app Notifications

- **GET** `/api/notifications?limit=20&offset=0&unreadOnly=false` — list notifications
- **POST** `/api/notifications/:id/read` — mark one as read
- **POST** `/api/notifications/read-all` — mark all as read

**Response:** `{ notifications: [...], total, unreadCount }` — each notification: `{ id, type, title, body, url, is_read, created_at, lead_id }`

**Types:** `new_lead`, `new_message`. Use `url` to navigate (e.g. `/inbox/<leadId>`, `/inbox/<leadId>/conversation`).

---

## F) CRM – Lead Detail (Activity / Notes / Tasks)

**CRITICAL:** Use the **lead.id** from the loaded Lead Detail. Do NOT use:
- `companyId` or `company.id`
- `conversation.id` or `conversation_id`
- Any ID from the URL that is not the lead UUID

**Frontend guard:** Before calling CRM endpoints, validate `leadId`:
```js
if (!leadId || typeof leadId !== 'string' || !/^[0-9a-f-]{36}$/i.test(leadId)) {
  // Show friendly message: "Unable to load CRM data"
  return;
}
```

### Endpoints (use lead.id from Lead Detail)

| Method | Path | Body |
|--------|------|------|
| GET | `/api/leads/:leadId/activity?limit=30&offset=0` | - |
| GET | `/api/leads/:leadId/notes?limit=50&offset=0` | - |
| GET | `/api/leads/:leadId/tasks?limit=50&offset=0&status=open` | - |
| POST | `/api/leads/:leadId/notes` | `{ "body": "..." }` |
| PATCH | `/api/leads/:leadId/notes/:noteId` | `{ "body": "..." }` |
| DELETE | `/api/leads/:leadId/notes/:noteId` | - |
| POST | `/api/leads/:leadId/tasks` | `{ "title": "...", "description?", "due_at?", "assigned_user_id?" }` |
| PATCH | `/api/leads/:leadId/tasks/:taskId` | `{ "title?", "description?", "status?", "due_at?", "assigned_user_id?" }` |
| DELETE | `/api/leads/:leadId/tasks/:taskId` | - |

**Alternative (with /crm/):** `/api/leads/:leadId/crm/activity`, `/crm/notes`, `/crm/tasks` also work.

**Response shapes:** `{ items: [...], total: number }` for GET. Empty lists: `{ items: [], total: 0 }`. Never null.

**Frontend defensive guard:** Before fetching, validate `leadId` and normalize response:
```js
const isValidLeadId = (id) => id && typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
if (!isValidLeadId(lead?.id)) return; // or show "Unable to load CRM"
const items = Array.isArray(res?.items) ? res.items : [];
```

**Headers:** `Authorization: Bearer <token>`, optional `x-company-id` (must match JWT company if sent).

**404:** If lead not found or not in tenant, returns `{ error: { code: "NOT_FOUND", message: "Lead not found" } }` (JSON, not HTML).

---

## G) Notification Settings (owner/admin)

- **GET** `/api/settings/notifications` — returns `{ email_enabled, email_recipients, notify_new_inquiry_inbox, notify_new_inquiry_simulation, updated_at }`. Defaults if no row.
- **PUT** `/api/settings/notifications` — save settings (owner/admin only). Body: `{ email_enabled?, email_recipients?, notify_new_inquiry_inbox?, notify_new_inquiry_simulation? }`.
