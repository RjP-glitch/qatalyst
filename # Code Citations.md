# Code Citations

## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (
```


## License: unknown
https://github.com/8Paprika5/BUT-IUT-Lannion-2021_2024/blob/116569858daf6927a8393193bb8b1c7499b2b104/BUT2-2022_2023/Alizon/V3/js/filtrerCommandes.js

```


I need to see what columns your Excel file has. But I'll update both `process.php` and `main.js` to include **all column data** (not just numeric ones) so you can see respondent info like Name, Email, Date, etc.

## 1. Updated `process.php`

````php
// filepath: c:\xampp\htdocs\import-excell\process.php
<?php
error_reporting(0);
ini_set('display_errors', 0);

require 'vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;

header('Content-Type: application/json');

try {
    if (!isset($_FILES['excel_file']) || $_FILES['excel_file']['error'] !== UPLOAD_ERR_OK) {
        throw new Exception('No file uploaded or upload error occurred.');
    }

    $file = $_FILES['excel_file'];
    $allowedExtensions = ['xlsx', 'xls', 'csv'];
    $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));

    if (!in_array($ext, $allowedExtensions)) {
        throw new Exception('Invalid file type. Please upload an Excel (.xlsx, .xls) or CSV file.');
    }

    $spreadsheet = IOFactory::load($file['tmp_name']);
    $sheet = $spreadsheet->getActiveSheet();
    $rows = $sheet->toArray(null, true, true, true);

    if (count($rows) < 2) {
        throw new Exception('The file appears to be empty or has no data rows.');
    }

    // First row is the header
    $headerRow = array_shift($rows);
    $headers = array_values($headerRow);

    $nameColIndex = null;
    $emailColIndex = null;
    $questionColumns = [];
    $infoColumns = [];

    foreach ($headers as $index => $header) {
        $headerLower = strtolower(trim($header ?? ''));

        if ($nameColIndex === null && (
            strpos($headerLower, 'name') !== false ||
            strpos($headerLower, 'respondent') !== false ||
            strpos($headerLower, 'pangalan') !== false
        )) {
            $nameColIndex = $index;
        } elseif ($emailColIndex === null && (
            strpos($headerLower, 'email') !== false ||
            strpos($headerLower, 'e-mail') !== false
        )) {
            $emailColIndex = $index;
        }
    }

    // Detect question/score columns vs info columns
    foreach ($headers as $index => $header) {
        $numericCount = 0;
        $totalCount = 0;

        foreach ($rows as $row) {
            $values = array_values($row);
            if (isset($values[$index]) && $values[$index] !== null && $values[$index] !== '') {
                $totalCount++;
                if (is_numeric($values[$index])) {
                    $numericCount++;
                }
            }
        }

        // If more than 60% of values are numeric, treat as score column
        if ($totalCount > 0 && ($numericCount / $totalCount) > 0.6) {
            $questionColumns[] = $index;
        } else {
            // Non-numeric columns are info columns
            $infoColumns[] = $index;
        }
    }

    if (empty($questionColumns)) {
        throw new Exception('No numeric/score columns detected in the file. Make sure your form has rating or numeric questions.');
    }

    // Process each respondent
    $respondents = [];
    $allAverages = [];

    foreach ($rows as $row) {
        $values = array_values($row);

        // Get respondent name
        $name = 'Unknown';
        if ($nameColIndex !== null && isset($values[$nameColIndex]) && trim($values[$nameColIndex]) !== '') {
            $name = trim($values[$nameColIndex]);
        } elseif ($emailColIndex !== null && isset($values[$emailColIndex]) && trim($values[$emailColIndex]) !== '') {
            $name = trim($values[$emailColIndex]);
        }

        // Skip empty rows
        $hasData = false;
        foreach ($questionColumns as $qi) {
            if (isset($values[$qi]) && $values[$qi] !== null && $values[$qi] !== '') {
                $hasData = true;
                break;
            }
        }
        if (!$hasData) continue;

        // Collect info fields
        $info = [];
        foreach ($infoColumns as $ii) {
            $val = isset($values[$ii]) ? trim($values[$ii] ?? '') : '';
            $info[] = $val;
        }

        // Collect scores
        $scores = [];
        foreach ($questionColumns as $qi) {
            $val = isset($values[$qi]) ? $values[$qi] : null;
            if (is_numeric($val)) {
                $scores[] = floatval($val);
            } else {
                $scores[] = null;
            }
        }

        // Calculate average
        $validScores = array_filter($scores, function ($s) {
            return $s !== null;
        });

        $average = count($validScores) > 0 ? array_sum($validScores) / count($validScores) : 0;
        $average = round($average, 2);

        $result = getResult($average);
        $allAverages[] = $average;

        $respondents[] = [
            'name' => $name,
            'info' => $info,
            'scores' => $scores,
            'average' => $average,
            'result' => $result
        ];
    }

    if (empty($respondents)) {
        throw new Exception('No valid respondent data found in the file.');
    }

    // Build headers
    $infoHeaders = [];
    foreach ($infoColumns as $ii) {
        $infoHeaders[] = $headers[$ii] ?? ('Col ' . ($ii + 1));
    }

    $questionHeaders = [];
    foreach ($questionColumns as $qi) {
        $questionHeaders[] = $headers[$qi] ?? ('Q' . ($qi + 1));
    }

    // All original column headers in order
    $allHeaders = [];
    foreach ($headers as $h) {
        $allHeaders[] = $h ?? '';
    }

    $overallAverage = count($allAverages) > 0 ? round(array_sum($allAverages) / count($allAverages), 2) : 0;
    $highest = count($allAverages) > 0 ? round(max($allAverages), 2) : 0;
    $lowest = count($allAverages) > 0 ? round(min($allAverages), 2) : 0;

    echo json_encode([
        'success' => true,
        'data' => [
            'totalRespondents' => count($respondents),
            'totalQuestions' => count($questionColumns),
            'overallAverage' => $overallAverage,
            'highest' => $highest,
            'lowest' => $lowest,
            'allHeaders' => $allHeaders,
            'infoHeaders' => $infoHeaders,
            'questionHeaders' => $questionHeaders,
            'respondents' => $respondents
        ]
    ]);

} catch (Exception $e) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => $e->getMessage()
    ]);
}

function getResult($average)
{
    if ($average >= 4.5) return 'Outstanding';
    if ($average >= 3.5) return 'Very Satisfactory';
    if ($average >= 2.5) return 'Satisfactory';
    if ($average >= 1.5) return 'Fair';
    return 'Needs Improvement';
}
````

## 2. Updated `main.js`

````javascript
// filepath: c:\xampp\htdocs\import-excell\js\main.js
document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('excelFile');
    const fileNameDiv = document.getElementById('fileName');
    const uploadForm = document.getElementById('uploadForm');
    const submitBtn = document.getElementById('submitBtn');
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    const errorMsg = document.getElementById('errorMsg');
    const resultsSection = document.getElementById('resultsSection');
    const summaryCards = document.getElementById('summaryCards');
    const tableHead = document.getElementById('tableHead');
    const tableBody = document.getElementById('tableBody');
    const searchInput = document.getElementById('searchInput');
    const exportBtn = document.getElementById('exportBtn');

    let resultsData = null;

    // ---- Drop Zone Events ----
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        if (
```

