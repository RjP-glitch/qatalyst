<?php
// routes.php

require_once 'controllers/HomeController.php';

$router = new Router();

$router->get('/', [HomeController::class, 'index']);

// Add more routes as needed

$router->run();
?>