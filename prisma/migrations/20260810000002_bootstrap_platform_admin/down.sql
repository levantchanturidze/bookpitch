-- Remove the bootstrapped SUPER_ADMIN if rolling back.
-- Only deletes users with this specific email to avoid touching other platform admins.
DELETE FROM app_users
WHERE email = 'levaaani@gmail.com'
  AND platform_role_id = (
    SELECT id FROM roles WHERE key = 'SUPER_ADMIN' AND organization_id IS NULL
  );
