<?php
/**
 * Submit Evaluation Response API (Legacy Redirect)
 *
 * DEPRECATED: This file previously wrote to a non-existent `evaluation_responses` table.
 * All evaluation submissions now go through evaluation.php POST handler, which correctly
 * writes to: evaluation_submissions -> evaluation_answers -> evaluation_speaker_answers.
 *
 * This file is kept for backward compatibility — it forwards POST requests to evaluation.php.
 */

// Delegate to the correct handler
require_once __DIR__ . '/evaluation.php';
?>