-- Remove site_visit from appointment/request types, add consultation and video_call

-- Update existing site_visit records to 'meeting'
UPDATE appointments SET appointment_type = 'meeting' WHERE appointment_type = 'site_visit';
UPDATE scheduling_requests SET request_type = 'meeting' WHERE request_type = 'site_visit';

-- Drop and recreate constraints with new allowed types
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_appointment_type_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_appointment_type_check
  CHECK (appointment_type IN ('call', 'meeting', 'follow_up', 'consultation', 'video_call'));

ALTER TABLE scheduling_requests DROP CONSTRAINT IF EXISTS scheduling_requests_request_type_check;
ALTER TABLE scheduling_requests ADD CONSTRAINT scheduling_requests_request_type_check
  CHECK (request_type IN ('call', 'meeting', 'follow_up', 'consultation', 'video_call'));
