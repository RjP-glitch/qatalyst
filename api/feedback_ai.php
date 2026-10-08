<?php
header('Content-Type: text/plain');
require_once __DIR__ . '/../config/database.php';
$apiKey = $_ENV['OPENAI_API_KEY'] ?? getenv('OPENAI_API_KEY') ?: '';
if ($apiKey === '') {
  http_response_code(503);
  echo 'Feedback summary service is not configured.';
  exit;
}
$feedback = $_POST['feedback'] ?? '';
if (!$feedback) { echo 'No feedback provided.'; exit; }
$model = 'gpt-5-nano'; // User requested model
$data = [
  'model' => $model,
  'messages' => [
    ['role' => 'system', 'content' => 'Summarize feedback and suggest improvements.'],
    ['role' => 'user', 'content' => $feedback]
  ]
];
$ch = curl_init('https://api.openai.com/v1/chat/completions');
curl_setopt($ch, CURLOPT_HTTPHEADER, [
  'Authorization: Bearer ' . $apiKey,
  'Content-Type: application/json'
]);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
$response = curl_exec($ch);
$curlErr = curl_error($ch);
curl_close($ch);
$result = json_decode($response, true);
if ($curlErr) {
  echo 'Curl error: ' . $curlErr;
  exit;
}
if (!$result) {
  echo 'OpenAI response error: ' . $response;
  exit;
}
if (isset($result['error'])) {
  echo 'OpenAI error: ' . $result['error']['message'];
  exit;
}
echo $result['choices'][0]['message']['content'] ?? 'No summary generated.';
