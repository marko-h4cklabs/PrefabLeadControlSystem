# ManyChat Settings UI Spec

Replace the "Instagram Connection" section on the Settings page with a "ManyChat Connection" section.

## API Endpoints

- **GET** `/api/settings/manychat` — returns `{ manychat_api_key (masked), manychat_page_id, has_api_key }`
- **PUT** `/api/settings/manychat` — body: `{ manychat_api_key?, manychat_page_id? }`

## Section Content

### ManyChat Connection

| Field | Type | Label | Placeholder | Helper text |
|-------|------|-------|-------------|-------------|
| API Key | password input | "ManyChat API Key" | "••••••••" | "Find this in ManyChat → Settings → API" |
| Page ID | text input | "ManyChat Page ID" | "your_page_id" | "Find this in ManyChat → Settings → General" |

- **Save button**: Yellow style
- **Connected status**:
  - If both `manychat_api_key` and `manychat_page_id` are set: Green dot + "Connected" badge
  - Otherwise: Gray dot + "Not connected"

## Response Shape (GET)

```json
{
  "manychat_api_key": "***************abc123",
  "manychat_page_id": "your_page_id",
  "has_api_key": true
}
```

Note: `manychat_api_key` is masked — only last 6 characters visible, rest asterisks. When saving, send the full value (user types it or leaves blank to keep existing).
