# Highlights Panel — Frontend Integration

## Overview

Replace the old right-side block ("Required Infos (missing) None / Collected Infos None yet / Captured Fields") with a new **Highlights** panel that displays dynamic, per-conversation state.

## API Contract

Every chat reply (`POST /api/chatbot/chat`) returns:

```json
{
  "assistant_message": "string",
  "conversation_id": "uuid",
  "highlights": {
    "settings": {
      "tone": "professional|friendly",
      "persona_style": "busy|explanational",
      "response_length": "short|medium|long",
      "emojis_enabled": boolean
    },
    "fields": {
      "configured": [
        { "name": string, "type": "text|number", "units": string|null, "priority": number, "required": boolean }
      ],
      "missing_required": [ same shape, only required+missing ],
      "collected": [
        { "name": string, "type": "text|number", "units": string|null, "value": any }
      ]
    },
    "state": {
      "step_index": number,
      "is_complete": boolean
    }
  }
}
```

## Panel Sections

### 1. Active Settings

Display `highlights.settings`:

- **Tone**: professional / friendly
- **Persona**: busy / explanational
- **Length**: short / medium / long
- **Emojis**: enabled / disabled

### 2. Missing Required

Display `highlights.fields.missing_required`:

- List of fields the bot still needs to collect
- Ordered by priority
- Empty when all required fields are collected

### 3. Collected

Display `highlights.fields.collected`:

- List of fields already collected with values
- Shown as `name: value` (with units if present)

## Implementation Steps

1. **Remove legacy UI**  
   Remove the old "Required Infos (missing) None / Collected Infos None yet / Captured Fields" placeholders.

2. **Add Highlights panel**  
   Create a right-side panel (or sidebar) with three sections:

   - Active Settings
   - Missing Required
   - Collected

3. **Update after each chat reply**  
   After each `POST /api/chatbot/chat` response:

   - Store `response.highlights`
   - Re-render the panel using `response.highlights`
   - Use `highlights.state.is_complete` to show completion state (e.g. "All required fields collected")

4. **Optional: GET /conversation/:id/fields**  
   If the user loads a conversation without sending a message, call `GET /api/chatbot/conversation/:conversationId/fields` to fetch the current state. The response includes `highlights` for that conversation.

## Data Flow

- `configured` is the full list of quote fields from company settings (dynamic per company).
- `missing_required` is computed each turn from configured fields vs. collected fields.
- `collected` comes from stored conversation data.
- `is_complete` is `true` when `missing_required` is empty.

## Manual Test Steps

1. **Configure quote fields dynamically** (e.g. only location + budget in UI).
2. **Start chat**:
   - Bot greets with 2–3 words, then asks for location.
   - After location answered, asks for budget.
   - No other questions.
3. **Change settings** to explainational + medium:
   - Bot can use 2–3 sentences but still only asks configured fields.
4. **Verify highlights** returned and list updates correctly after each reply.
