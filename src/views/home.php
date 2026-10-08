<?php
include_once '../views/layout.php';

function renderHomePage() {
    ?>
    <div class="home">
        <h1>Welcome to My PHP App</h1>
        <p>This is the home page of the application.</p>
    </div>
    <?php
}

renderHomePage();
?>