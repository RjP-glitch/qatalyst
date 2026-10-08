<?php
/**
 * API Response Handler
 *
 * Responsible only for formatting and sending JSON responses.
 * CORS, security headers, and preflight handling must be done
 * by the calling script (e.g. via security.php) — not here.
 */

class Response {
    private $statusCode;
    private $data;
    private $message;
    private $errors;

    /**
     * Send success response
     */
    public function success($data = null, $message = 'Success', $statusCode = 200) {
        $this->statusCode  = $statusCode;
        $this->data        = $data;
        $this->message     = $message;
        $this->errors      = [];

        $this->send();
    }

    /**
     * Send error response
     */
    public function error($message = 'Error', $errors = [], $statusCode = 400) {
        $this->statusCode  = $statusCode;
        $this->data        = null;
        $this->message     = $message;
        $this->errors      = is_array($errors) ? $errors : [$errors];

        $this->send();
    }

    /**
     * Build and emit the JSON response, then halt execution.
     */
    private function send() {
        if (ob_get_length()) {
            ob_clean();
        }

        http_response_code($this->statusCode);

        $response = [
            'success'    => $this->statusCode >= 200 && $this->statusCode < 300,
            'statusCode' => $this->statusCode,
            'message'    => $this->message,
            'data'       => $this->data,
            'errors'     => $this->errors,
            'timestamp'  => date('Y-m-d H:i:s'),
        ];

        echo json_encode($response, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        exit;
    }
}
?>