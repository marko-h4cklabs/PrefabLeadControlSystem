Prefab Lead Control System – MVP Specification

1. Project Overview
Project Name: Prefab Lead Control System
Purpose:
Automate lead intake, pre-qualification, scoring, and appointment scheduling for prefabricated/modular construction companies with fully customizable fields and chatbot style per company.
MVP Goals:
Omnichannel lead intake: Messenger, Instagram, Email
Configurable fields per company (budget, size, location, timeline, financing, etc.)
Human-like chatbot using Claude 3.5 Sonnet
Lead scoring engine
Appointment scheduling for qualified leads
Client dashboard for per-company customization
Analytics: conversation metrics, lead conversion
Design Principles:
Scalable: multiple companies in the same system
Adaptable: each company can configure fields, scoring, and chatbot style
Deterministic business logic enforced by backend (Cursor)
Human-like conversational flow handled by LLM (Claude 3.5 Sonnet)

2. System Architecture
High-Level Components:
Layer
Component
Responsibility
Frontend
Lovable
Dashboard UI, conversation interface, admin panel for fields & style, pipeline view, analytics
Backend
Cursor
Lead ingestion, conversation orchestration, LLM integration, scoring logic, appointment triggers, database API
Database
Supabase/Postgres
Stores companies, leads, fields, scoring, conversations, appointments
Messaging
Meta Graph API, Email
Messenger, Instagram, Email ingestion & outbound messages
Appointment
Calendly / Google Calendar API
Appointment scheduling
LLM
Claude 3.5 Sonnet
Free-text interpretation, human-like phrasing, style adaptation

Data Flow:
Lead sends message → Meta Graph / Email → Cursor backend webhook
Cursor loads company-specific fields & chatbot rules, sends free-text to Claude 3.5 for parsing, updates lead record, calculates score, generates next question
Lovable frontend displays lead list, conversation, pipeline, and analytics, and allows admin configuration
Appointment scheduling triggered for qualified leads

3. Responsibilities & Division of Work
Lovable – Frontend Responsibilities:
Lead Dashboard: list, score, pipeline, conversation summary
Admin Panel (per company): add/edit/remove fields, configure field types, validation, scoring weights, chatbot style (tone, forbidden fields, response duration)
Appointment interface: trigger booking link
Fetch data from Cursor APIs and render UI
Do not implement lead ingestion, scoring, or LLM logic
Cursor – Backend Responsibilities:
Lead ingestion from Messenger, Instagram, Email
Conversation orchestration using Claude 3.5
Enforce deterministic lead scoring and qualification logic
Trigger appointments when thresholds met
Database management: tables for companies, leads, conversations, fields, appointments
Provide APIs for Lovable to fetch/update data
Do not build frontend UI
Per-Company Customization:
Each company independently configures fields, scoring weights, and chatbot style
Cursor stores configuration; Lovable retrieves for UI rendering
Claude 3.5 adapts conversation dynamically per company configuration

4. Database Schema
Tables:
companies: id, name, contact info, chatbot_style, scoring_config, channels_enabled
leads: id, company_id, channel, score, status, assigned_sales, created_at
conversations: id, lead_id, messages[], current_step, last_updated, parsed_fields
qualification_fields: id, company_id, field_name, field_type, units/currency, required, scoring_weight, dependencies
appointments: id, lead_id, scheduled_time, status, calendar_id
analytics: lead conversions, conversation metrics, avg qualification time, lead score distribution

5. Chatbot Flow & LLM Integration
Load company configuration (fields, rules, style)
Greet lead in configured tone
Ask first required field
Send lead response to Claude 3.5 → extract structured value
Update database and score lead
Determine next question based on dynamic flow
If all required fields collected, trigger appointment if lead is Hot
Continue conversation for optional fields
LLM Roles:
Interpret free-text responses
Generate human-like, in-scope questions
Maintain company-specific tone
Never modify scoring or enforce business rules

6. MVP Feature Roadmap
Feature
MVP Implementation
Scalability Notes
Lead Intake
Messenger, Instagram, Email
Add WhatsApp or website widget later
Qualification Fields
Configurable per company
Add more field types (dropdown, checkbox) later
Lead Scoring
Weighted by fields
Support advanced scoring formulas later
Chatbot Conversation
Claude 3.5 Sonnet
Tone, style, forbidden fields configurable per company
Appointment Setting
Trigger booking link
Integrate multiple calendars later
Dashboard
Leads, pipeline, conversation, analytics
Modular for advanced analytics in future


7. Project Structure
Frontend (Lovable):
/frontend
  /components
    Dashboard.vue
    LeadList.vue
    PipelineView.vue
    ConversationView.vue
    AdminPanel.vue
    Analytics.vue
  /pages
    Login.vue
    Home.vue
    Settings.vue
  /services
    api.js  // fetch from Cursor
  /store
    leads.js
    conversations.js
    analytics.js

Backend (Cursor):
/backend
  /api
    leads.js
    conversations.js
    scoring.js
    appointments.js
    companies.js
    fields.js
  /llm
    claudeClient.js
    promptTemplates.js
    conversationHandler.js
  /db
    schema.sql
    migrations/
  /workers
    analyticsWorker.js
  /integrations
    metaAPI.js
    emailAPI.js
    calendarAPI.js


8. Collaboration Process
Version Control: GitHub repo containing Lovable (frontend) and Cursor (backend) in separate folders
Integration: Lovable calls Cursor REST API endpoints; Cursor returns structured JSON
Per-Company Config: Stored in Cursor DB, fetched by Lovable at login
Hosting: For MVP, GitHub + Vercel (Lovable), Railway / Render (Cursor)
LLM Management: Cursor handles prompts, token usage; Lovable displays messages
Process Example:
Lovable fetches /api/companies/{id}/fields → renders admin panel
Lead messages → Cursor webhook → LLM parses → updates DB → returns JSON
Lovable displays conversation, score, pipeline stage

9. Coding Guidelines
Lovable:
Focus on UI, responsive dashboards, visualization
Fetch all data from backend API
Do not implement backend logic or LLM handling
Cursor:
Implement backend logic, lead scoring, conversation orchestration
LLM integration for free-text parsing & conversation style
Database management
Shared Guidelines:
Strict adherence to API contracts
Consistent naming of fields & IDs
Cursor manages database schema

10. Navigation / LLM Prompts
Lovable:
Build dashboard, lead view, conversation view, admin panel, analytics
Fetch configuration & conversation data via API
Cursor:
Build endpoints for leads, conversations, fields, appointments, scoring, analytics
Handle LLM prompts for natural language interpretation
Enforce deterministic business rules
Per-User Customization Confirmed:
Each company independently configures fields, scoring, and chatbot style
Claude 3.5 Sonnet adapts conversations per company configuration
End of Document


