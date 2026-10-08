<?php http_response_code(404); ?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 – Page Not Found | QATALYST</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
    <link rel="stylesheet" href="/css/404.css">
    <style>
        /* ── CSS variables (dark default / light override) ── */
        :root {
            --bg:          #080d14;
            --text:        #e8edf5;
            --text2:       #9aa3b5;
            --text3:       #6b7a95;
            --grid:        rgba(255,255,255,0.025);
            --gbtn-color:  #e8edf5;
            --gbtn-bdr:    rgba(255,255,255,0.2);
            --gbtn-hbg:    rgba(255,255,255,0.07);
        }
        body.light {
            --bg:         #f0f4ff;
            --text:       #0d1117;
            --text2:      #334155;
            --text3:      #64748b;
            --grid:       rgba(0,0,0,0.04);
            --gbtn-color: #0d1117;
            --gbtn-bdr:   rgba(0,0,0,0.2);
            --gbtn-hbg:   rgba(0,0,0,0.05);
        }
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'DM Sans', sans-serif;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
            overflow-x: hidden;
            transition: background .35s, color .35s;
        }
        /* Grid background */
        .gridbg {
            position: fixed; inset: 0; z-index: 0; pointer-events: none;
            background-image:
                linear-gradient(var(--grid) 1px, transparent 1px),
                linear-gradient(90deg, var(--grid) 1px, transparent 1px);
            background-size: 60px 60px;
        }
    </style>
</head>
<body>

    <div class="gridbg" aria-hidden="true"></div>

    <?php if (file_exists(__DIR__ . '/includes/header.php')) include 'includes/header.php'; ?>

    <main class="not-found" role="main">
        <div class="not-found-ghost" aria-hidden="true">404</div>

        <div class="not-found-inner">
            <div class="not-found-badge">
                <span class="not-found-badge-dot" aria-hidden="true"></span>
                Error 404
            </div>

            <h1>404</h1>
            <h2>Page not found</h2>
            <p>The page you're looking for doesn't exist or may have been moved.</p>

            <div class="not-found-actions">
                <a href="/" class="btn btn-p btn-lg">
                    <i class="fas fa-home" aria-hidden="true"></i> Go home
                </a>
                <a href="javascript:history.back()" class="btn btn-g btn-lg">
                    <i class="fas fa-arrow-left" aria-hidden="true"></i> Go back
                </a>
            </div>

            <nav class="not-found-crumbs" aria-label="Breadcrumb">
                <a href="/">Home</a>
                <span>/</span>
                <span>404</span>
            </nav>
        </div>
    </main>

    <?php if (file_exists(__DIR__ . '/includes/footer.php')) include 'includes/footer.php'; ?>

    <script>
        // Restore saved theme (same logic as main site)
        const saved = localStorage.getItem('qatalyst-theme');
        if (saved === 'light') document.body.classList.add('light');
    </script>

</body>
</html>