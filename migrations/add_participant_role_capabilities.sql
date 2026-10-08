-- Add capabilities column to participant_roles table
-- Run this migration to add role capabilities feature

ALTER TABLE `participant_roles` 
ADD COLUMN `capabilities` JSON NULL DEFAULT NULL 
COMMENT 'JSON object containing role capabilities' 
AFTER `description`;

-- Update existing roles with default capabilities
UPDATE `participant_roles` SET `capabilities` = '{"can_submit_evaluation": true, "can_view_results": false, "can_be_evaluated": false, "can_receive_certificate": true, "can_view_analytics": false}' 
WHERE role_name LIKE '%Respondent%' OR role_name LIKE '%Participant%';

UPDATE `participant_roles` SET `capabilities` = '{"can_submit_evaluation": false, "can_view_results": true, "can_be_evaluated": false, "can_receive_certificate": true, "can_view_analytics": true}' 
WHERE role_name LIKE '%Proponent%' OR role_name LIKE '%Organizer%';

UPDATE `participant_roles` SET `capabilities` = '{"can_submit_evaluation": false, "can_view_results": false, "can_be_evaluated": true, "can_receive_certificate": true, "can_view_analytics": false}' 
WHERE role_name LIKE '%Speaker%' OR role_name LIKE '%Resource%';
