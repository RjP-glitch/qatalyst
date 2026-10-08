<?php
/**
 * Email Helper using PHPMailer with SMTP (Gmail)
 */

require_once dirname(__DIR__) . '/vendor/autoload.php';

use PHPMailer\PHPMailer\PHPMailer;
use PHPMailer\PHPMailer\Exception;

class EmailHelper {
    private $smtpHost = 'smtp.gmail.com';
    private $smtpPort = 587;
    private $smtpUser;
    private $smtpPass;
    private $fromEmail;
    private $fromName = 'QRES Dashboard';

    private $lastError = '';

    public function __construct() {
        // Most API callers load .env through database.php. Standalone callers
        // can load the same local configuration without requiring a database.
        if (is_file(dirname(__DIR__) . '/.env')) {
            \Dotenv\Dotenv::createImmutable(dirname(__DIR__))->safeLoad();
        }
        $this->smtpHost = $_ENV['SMTP_HOST'] ?? getenv('SMTP_HOST') ?: 'smtp.gmail.com';
        $this->smtpPort = (int)($_ENV['SMTP_PORT'] ?? getenv('SMTP_PORT') ?: 587);
        $this->smtpUser = $_ENV['SMTP_USERNAME'] ?? getenv('SMTP_USERNAME') ?: '';
        $this->smtpPass = $_ENV['SMTP_PASSWORD'] ?? getenv('SMTP_PASSWORD') ?: '';
        $this->fromEmail = $_ENV['SMTP_FROM_EMAIL'] ?? getenv('SMTP_FROM_EMAIL') ?: $this->smtpUser;
        $this->fromName = $_ENV['SMTP_FROM_NAME'] ?? getenv('SMTP_FROM_NAME') ?: 'QRES Dashboard';
    }

    public function getLastError(): string {
        return $this->lastError;
    }

    /**
     * Send verification code
     */
    public function sendVerificationCode($email, $code, $userName = 'User') {
        $subject = "QRES Dashboard - Email Verification Code";
        $htmlMessage = $this->getVerificationEmailTemplate($code, $userName);
        
        return $this->sendEmail($email, $subject, $htmlMessage);
    }

    /**
     * Send newly created account credentials
     */
    public function sendAccountCredentials($email, $userName, $plainPassword, $loginUrl = null) {
        $subject = "QRES Dashboard - Your Account Has Been Created";
        $htmlMessage = $this->getCredentialsEmailTemplate($userName, $email, $plainPassword, $loginUrl);

        return $this->sendEmail($email, $subject, $htmlMessage);
    }

    /**
     * Send password reset code
     */
    public function sendPasswordResetCode($email, $code, $userName = 'User') {
        $subject = "QRES Dashboard - Password Reset Code";
        $htmlMessage = $this->getPasswordResetEmailTemplate($code, $userName);
        
        return $this->sendEmail($email, $subject, $htmlMessage);
    }

    /**
     * Send evaluation reminder email
     */
    public function sendEvaluationReminder($email, $name, $workshopTitle, $evaluationLink) {
        $subject = "QRES Dashboard - Evaluation Reminder: $workshopTitle";
        $htmlMessage = $this->getEvaluationReminderTemplate($name, $workshopTitle, $evaluationLink);
        
        return $this->sendEmail($email, $subject, $htmlMessage);
    }

    /**
     * Send certificate email with optional PDF attachment
     * Called by certificates_api.php for single and bulk sends
     *
     * @param string      $to             Recipient email address
     * @param string      $name           Recipient full name
     * @param string      $subject        Email subject line
     * @param string      $body           Plain-text message body (newlines preserved)
     * @param string|null $attachmentPath Full server path to a PDF file, or null
     */
    public function sendCertificateEmail($to, $name, $subject, $body, $attachmentPath = null) {
        $htmlMessage = $this->getCertificateEmailTemplate($name, $body);

        try {
            $mail = new PHPMailer(true);

            // Server settings
            $mail->isSMTP();
            $mail->Host       = $this->smtpHost;
            $mail->SMTPAuth   = true;
            $mail->Username   = $this->smtpUser;
            $mail->Password   = $this->smtpPass;
            $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
            $mail->Port       = $this->smtpPort;

            // Recipients
            $mail->setFrom($this->fromEmail, $this->fromName);
            $mail->addAddress($to, $name);

            // Attach certificate PDF if provided
            if ($attachmentPath && file_exists($attachmentPath)) {
                $fileName = basename($attachmentPath);
                // Strip both cert_ and file_ uniqid prefixes, then remove .enc extension
                $cleanName = preg_replace('/^(?:cert|file)_[a-z0-9.]+_/i', '', $fileName);
                $cleanName = preg_replace('/\.enc$/i', '', $cleanName); // remove .enc so it shows as .pdf
                $mail->addAttachment($attachmentPath, $cleanName);
            }

            // Content
            $mail->isHTML(true);
            $mail->Subject = $subject;
            $mail->Body    = $htmlMessage;
            $mail->AltBody = strip_tags(nl2br($body));

            $mail->send();

            return true;

        } catch (\Throwable $e) {
            $this->lastError = $e->getMessage();
            error_log('EmailHelper::sendCertificateEmail error: ' . $e->getMessage());
            return false;
        }
    }

    /**
     * Send email using PHPMailer
     */
    private function sendEmail($to, $subject, $htmlMessage) {
        try {
            $mail = new PHPMailer(true);

            // Server settings
            $mail->isSMTP();
            $mail->Host = $this->smtpHost;
            $mail->SMTPAuth = true;
            $mail->Username = $this->smtpUser;
            $mail->Password = $this->smtpPass;
            $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
            $mail->Port = $this->smtpPort;

            // Recipients
            $mail->setFrom($this->fromEmail, $this->fromName);
            $mail->addAddress($to);

            // Content
            $mail->isHTML(true);
            $mail->Subject = $subject;
            $mail->Body = $htmlMessage;
            $mail->AltBody = strip_tags($htmlMessage);

            // Send
            $result = $mail->send();
            
            return true;

        } catch (\Throwable $e) {
            $this->lastError = $e->getMessage();
            error_log('EmailHelper::sendEmail error: ' . $e->getMessage());
            return false;
        }
    }

    /**
     * Certificate email HTML template
     */
    private function getCertificateEmailTemplate($name, $body) {
        // Convert plain-text newlines to <br> for the HTML version
        $htmlBody = nl2br(htmlspecialchars($body));

        return "
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; background-color: #f5f5f5; }
                    .container { max-width: 560px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .header { background: linear-gradient(to right, #1e3a8a, #1e40af); color: white; padding: 20px; border-radius: 5px; text-align: center; }
                    .header h2 { margin: 0; font-size: 20px; }
                    .header p { margin: 6px 0 0; font-size: 13px; opacity: 0.85; }
                    .content { padding: 24px 0 10px; color: #374151; line-height: 1.7; font-size: 15px; }
                    .cert-badge { background: #eff6ff; border-left: 4px solid #1e3a8a; border-radius: 5px; padding: 16px 20px; margin: 20px 0; display: flex; align-items: center; gap: 12px; }
                    .cert-badge .icon { font-size: 28px; }
                    .cert-badge .label { font-size: 13px; color: #6b7280; margin: 0; }
                    .cert-badge .cert-title { font-size: 15px; font-weight: bold; color: #1e3a8a; margin: 2px 0 0; }
                    .attachment-note { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 10px 14px; font-size: 13px; color: #15803d; margin-top: 16px; }
                    .footer { color: #9ca3af; font-size: 12px; margin-top: 30px; text-align: center; border-top: 1px solid #f3f4f6; padding-top: 20px; }
                </style>
            </head>
            <body>
                <div class='container'>
                    <div class='header'>
                        <h2>🏅 Certificate of Participation</h2>
                        <p>Schools Division of City of Baliwag</p>
                    </div>
                    <div class='content'>
                        $htmlBody
                        <div class='attachment-note'>
                            📎 Your certificate is attached to this email as a PDF file.
                        </div>
                    </div>
                    <div class='footer'>
                        <p>&copy; 2026 QRES Dashboard &mdash; SDO Baliwag SMME. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        ";
    }

    /**
     * Get verification email HTML template
     */
    private function getVerificationEmailTemplate($code, $userName) {
        return "
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; background-color: #f5f5f5; }
                    .container { max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .header { background: linear-gradient(to right, #1e3a8a, #1e40af); color: white; padding: 20px; border-radius: 5px; text-align: center; }
                    .header h2 { margin: 0; }
                    .content { padding: 20px 0; }
                    .code-box { background: #f0f9ff; padding: 20px; text-align: center; border-radius: 5px; border-left: 4px solid #1e3a8a; margin: 20px 0; }
                    .code { font-size: 32px; font-weight: bold; letter-spacing: 3px; color: #1e3a8a; }
                    .footer { color: #666; font-size: 12px; margin-top: 30px; text-align: center; border-top: 1px solid #eee; padding-top: 20px; }
                </style>
            </head>
            <body>
                <div class='container'>
                    <div class='header'>
                        <h2>Email Verification</h2>
                    </div>
                    <div class='content'>
                        <p>Hi " . htmlspecialchars($userName) . ",</p>
                        <p>Your verification code is:</p>
                        <div class='code-box'>
                            <div class='code'>" . htmlspecialchars($code) . "</div>
                        </div>
                        <p><strong>This code expires in 10 minutes.</strong></p>
                        <p>If you didn't request this code, please ignore this email.</p>
                    </div>
                    <div class='footer'>
                        <p>&copy; 2026 QRES Dashboard &mdash; SDO Baliwag SMME. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        ";
    }

    /**
     * Get account credentials email HTML template
     */
    private function getCredentialsEmailTemplate($userName, $email, $plainPassword, $loginUrl = null) {
        $loginButton = $loginUrl
            ? "<p style='text-align: center;'><a href='" . htmlspecialchars($loginUrl) . "' class='btn'>Log In</a></p>"
            : '';

        return "
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; background-color: #f5f5f5; }
                    .container { max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .header { background: linear-gradient(to right, #1e3a8a, #1e40af); color: white; padding: 20px; border-radius: 5px; text-align: center; }
                    .header h2 { margin: 0; }
                    .content { padding: 20px 0; }
                    .creds-box { background: #f0f9ff; padding: 20px; border-radius: 5px; border-left: 4px solid #1e3a8a; margin: 20px 0; }
                    .creds-row { margin: 8px 0; font-size: 14px; }
                    .creds-label { color: #6b7280; }
                    .creds-value { font-weight: bold; color: #1e3a8a; font-family: monospace; font-size: 15px; }
                    .btn { display: inline-block; background: #1e3a8a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 15px 0; }
                    .warning { background: #fee2e2; padding: 15px; border-left: 4px solid #dc2626; margin: 20px 0; border-radius: 5px; }
                    .warning strong { color: #dc2626; }
                    .footer { color: #666; font-size: 12px; margin-top: 30px; text-align: center; border-top: 1px solid #eee; padding-top: 20px; }
                </style>
            </head>
            <body>
                <div class='container'>
                    <div class='header'>
                        <h2>Your Account Has Been Created</h2>
                    </div>
                    <div class='content'>
                        <p>Hi " . htmlspecialchars($userName) . ",</p>
                        <p>An account has been created for you on the QRES Dashboard. Here are your login credentials:</p>
                        <div class='creds-box'>
                            <div class='creds-row'><span class='creds-label'>Email:</span><br><span class='creds-value'>" . htmlspecialchars($email) . "</span></div>
                            <div class='creds-row'><span class='creds-label'>Temporary Password:</span><br><span class='creds-value'>" . htmlspecialchars($plainPassword) . "</span></div>
                        </div>
                        $loginButton
                        <div class='warning'>
                            <strong>⚠️ Security Notice:</strong> Please log in and change your password as soon as possible. Do not share these credentials with anyone.
                        </div>
                    </div>
                    <div class='footer'>
                        <p>&copy; 2026 QRES Dashboard &mdash; SDO Baliwag SMME. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        ";
    }

    /**
     * Get password reset email HTML template
     */
    private function getPasswordResetEmailTemplate($code, $userName) {
        return "
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; background-color: #f5f5f5; }
                    .container { max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .header { background: linear-gradient(to right, #1e3a8a, #1e40af); color: white; padding: 20px; border-radius: 5px; text-align: center; }
                    .header h2 { margin: 0; }
                    .content { padding: 20px 0; }
                    .code-box { background: #f0f9ff; padding: 20px; text-align: center; border-radius: 5px; border-left: 4px solid #1e3a8a; margin: 20px 0; }
                    .code { font-size: 32px; font-weight: bold; letter-spacing: 3px; color: #1e3a8a; }
                    .warning { background: #fee2e2; padding: 15px; border-left: 4px solid #dc2626; margin: 20px 0; border-radius: 5px; }
                    .warning strong { color: #dc2626; }
                    .footer { color: #666; font-size: 12px; margin-top: 30px; text-align: center; border-top: 1px solid #eee; padding-top: 20px; }
                </style>
            </head>
            <body>
                <div class='container'>
                    <div class='header'>
                        <h2>Password Reset Request</h2>
                    </div>
                    <div class='content'>
                        <p>Hi " . htmlspecialchars($userName) . ",</p>
                        <p>We received a request to reset your password. Your reset code is:</p>
                        <div class='code-box'>
                            <div class='code'>" . htmlspecialchars($code) . "</div>
                        </div>
                        <p><strong>This code expires in 1 hour.</strong></p>
                        <div class='warning'>
                            <strong>⚠️ Security Notice:</strong> If you didn't request this, please change your password immediately and contact support.
                        </div>
                    </div>
                    <div class='footer'>
                        <p>&copy; 2026 QRES Dashboard &mdash; SDO Baliwag SMME. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        ";
    }

    /**
     * Get evaluation reminder email HTML template
     */
    private function getEvaluationReminderTemplate($name, $workshopTitle, $evaluationLink) {
        return "
            <!DOCTYPE html>
            <html>
            <head>
                <style>
                    body { font-family: Arial, sans-serif; background-color: #f5f5f5; }
                    .container { max-width: 500px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .header { background: linear-gradient(to right, #1e3a8a, #1e40af); color: white; padding: 20px; border-radius: 5px; text-align: center; }
                    .header h2 { margin: 0; }
                    .content { padding: 20px 0; }
                    .workshop-box { background: #f0f9ff; padding: 20px; border-radius: 5px; border-left: 4px solid #1e3a8a; margin: 20px 0; }
                    .workshop-title { font-size: 18px; font-weight: bold; color: #1e3a8a; }
                    .btn { display: inline-block; background: #1e3a8a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; margin: 15px 0; }
                    .footer { color: #666; font-size: 12px; margin-top: 30px; text-align: center; border-top: 1px solid #eee; padding-top: 20px; }
                </style>
            </head>
            <body>
                <div class='container'>
                    <div class='header'>
                        <h2>Evaluation Reminder</h2>
                    </div>
                    <div class='content'>
                        <p>Hi " . htmlspecialchars($name) . ",</p>
                        <p>This is a friendly reminder to complete your evaluation for:</p>
                        <div class='workshop-box'>
                            <div class='workshop-title'>" . htmlspecialchars($workshopTitle) . "</div>
                        </div>
                        <p>Your feedback is valuable and helps us improve future programs.</p>
                        <p style='text-align: center;'>
                            <a href='" . htmlspecialchars($evaluationLink) . "' class='btn'>Complete Evaluation</a>
                        </p>
                        <p style='font-size: 12px; color: #666;'>If the button doesn't work, copy this link: " . htmlspecialchars($evaluationLink) . "</p>
                    </div>
                    <div class='footer'>
                        <p>&copy; 2026 QRES Dashboard. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        ";
    }
}
?>
