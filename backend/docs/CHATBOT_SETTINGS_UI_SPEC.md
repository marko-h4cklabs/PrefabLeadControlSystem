# Chatbot Settings UI Spec — /fields Page

This document describes the Chatbot Settings UI for the `/fields` route. The backend API (`GET/PUT /api/chatbot/behavior`) supports all fields below. Implement the frontend according to this spec.

## API Endpoints

- **GET** `/api/chatbot/behavior` — returns full behavior config
- **PUT** `/api/chatbot/behavior` — accepts partial or full behavior; merges with existing. Use for per-section saves.

## Visual Style

- **Page background**: Dark `#1A1A1A`
- **Section cards**: Dark bg `#1A1A1A`, border `#2A2A2A`, **yellow left border** (4px solid `#F5C518`)
- **Primary accent**: Yellow `#F5C518`
- **Selected button**: Yellow bg `#F5C518`, black text
- **Unselected button**: Dark bg, light text
- **Save confirmation**: Yellow checkmark inline (no toast)

## Section 1 — Agent Identity

| Field | Type | Label | Placeholder | Saves to |
|-------|------|-------|-------------|----------|
| Agent Name | text input | "Agent Name" | "Jarvis" | `agent_name` |
| Agent Backstory | textarea | "Agent Backstory" | "Write 2-3 sentences about who this agent is. Example: I handle all new inquiries for the brand. I'm pretty direct — I'll ask a few things to see if we're a good fit." | `agent_backstory` |
| Bot Detection Response | textarea | "What does the agent say if someone asks if they're a bot?" | (default: "Nope, real person here 😄 What can I help you with?") | `bot_deny_response` |

**Save button**: Calls `PUT /api/chatbot/behavior` with `{ agent_name, agent_backstory, bot_deny_response }` merged into full behavior.

---

## Section 2 — Conversation Style

| Field | Type | Options | Saves to |
|-------|------|---------|----------|
| Opening Style | Button group (3 options) | Casual → "Hey, what's good 👋" / Professional → "Thanks for reaching out" / Direct → "What do you need?" | `opener_style` |
| Tone | Dropdown | professional, friendly | `tone` |
| Persona | Toggle | busy / explanational | `persona_style` |
| Response Length | Dropdown | short, medium, long | `response_length` |
| Emojis | Toggle | on/off | `emojis_enabled` |

**Save button**: Calls `PUT` with `{ opener_style, tone, persona_style, response_length, emojis_enabled }`.

---

## Section 3 — Conversation Strategy

| Field | Type | Options | Saves to |
|-------|------|---------|----------|
| Primary Goal | 4-option button group with icon | 📅 Book a Call / 📋 Collect Quote Info / 🔍 Qualify the Lead / 📇 Capture Contact Info | `conversation_goal` |
| Human Handoff | Label: "When should the agent hand off to a real person?" 4-option button group | After quote is collected / After booking is confirmed / Never (AI handles everything) / Only if user asks | `handoff_trigger` |
| Human Handoff Message | textarea | Label: "What does the agent say when handing off?" Placeholder: "Let me get someone from the team to follow up with you directly." | `human_fallback_message` |
| Follow-up Style | Label: "How should the agent re-engage cold leads?" 3-option button group | Soft ("Hey, just checking in") / Direct ("Still interested?") / Value-add ("Thought this might help you decide") | `follow_up_style` |

**Save button**: Calls `PUT` with `{ conversation_goal, handoff_trigger, human_fallback_message, follow_up_style }`.

---

## Section 4 — Data Collection

Existing quote fields toggle grid. Same functionality, restyle to match dark theme with yellow toggles.

**Save button**: Uses existing quote-fields API (`PUT /api/chatbot/quote-fields` or quote-presets).

---

## Section 5 — Guardrails

| Field | Type | Saves to |
|-------|------|----------|
| Forbidden Topics | Existing field | `forbidden_topics` |

Restyle to match dark theme.

**Save button**: Calls `PUT` with `{ forbidden_topics }`.

---

## Per-Section Save Flow

1. On load, fetch full behavior via `GET /api/chatbot/behavior`.
2. Each section has its own Save button.
3. On Save for a section, merge that section's fields into the full behavior object and call `PUT /api/chatbot/behavior` with the merged payload.
4. Show yellow checkmark inline next to Save when successful (no toast).

## Response Shape (GET /api/chatbot/behavior)

```json
{
  "tone": "professional",
  "response_length": "medium",
  "emojis_enabled": false,
  "persona_style": "busy",
  "forbidden_topics": [],
  "agent_name": "Jarvis",
  "agent_backstory": null,
  "opener_style": "casual",
  "conversation_goal": "collect_quote",
  "handoff_trigger": "after_quote",
  "follow_up_style": "soft",
  "human_fallback_message": "Let me get someone from the team to follow up with you directly.",
  "bot_deny_response": "Nope, real person here 😄 What can I help you with?"
}
```

## Enum Values (for validation)

- `opener_style`: `casual` | `professional` | `direct`
- `conversation_goal`: `book_call` | `collect_quote` | `qualify_lead` | `capture_contact`
- `handoff_trigger`: `after_quote` | `after_booking` | `never` | `on_request`
- `follow_up_style`: `soft` | `direct` | `value_add`
