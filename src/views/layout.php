<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>My PHP App</title>
    <link rel="stylesheet" href="/css/style.css">
</head>
<body>
    <header>
        <h1>Welcome to My PHP App</h1>
    </header>
    <main>
        <?php echo $content; ?>
    </main>
    <footer>
        <p>&copy; <?php echo date("Y"); ?> My PHP App. All rights reserved.</p>
    </footer>
    <script src="/js/main.js"></script>
</body>
</html>