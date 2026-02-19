# Chatbot Company Info – Frontend Requirements

## Website URL & Scrape Flow

**Required flow:**
1. User enters website URL in the input field
2. User clicks **Scrape** to start the process
3. Scraping runs in the background (takes a few minutes)

**Important:** Scraping must NOT start automatically. It must only start when the user explicitly clicks the Scrape button.

### API Usage

- **PUT `/api/chatbot/company-info`** – Save company info (including `website_url`). Call when user saves or when you need to persist the URL.
- **POST `/api/chatbot/company-info/scrape`** – Start scraping. **Requires `website_url` in the request body.**

```json
POST /api/chatbot/company-info/scrape
Content-Type: application/json

{ "website_url": "https://example.com" }
```

If `website_url` is missing or empty, the API returns 400 with:
`"website_url is required. Enter the website URL first, then click Scrape."`

### Form Behavior

- **Do NOT** overwrite the website URL input with server data while the user is typing or has unsaved changes
- When the user clicks Scrape, send the **current value** of the website URL input in the request body
- Do not trigger scrape on page load, on blur, or when the URL changes – only when the user clicks Scrape

## Polling

When `scrape_status` is `queued` or `running`, poll **GET `/api/chatbot/company-info`** to check status.

**Recommended:** Poll every **5 seconds** (the API returns `X-Poll-Interval: 5000` as a hint). Avoid polling more frequently (e.g. every 500ms) to reduce network traffic.

Stop polling when `scrape_status` is `finished`, `failed`, or `idle`.
