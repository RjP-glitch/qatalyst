<?php

class User {
    private $id;
    private $name;
    private $email;

    public function __construct($id, $name, $email) {
        $this->id = $id;
        $this->name = $name;
        $this->email = $email;
    }

    public function getId() {
        return $this->id;
    }

    public function getName() {
        return $this->name;
    }

    public function getEmail() {
        return $this->email;
    }

    public function setName($name) {
        $this->name = $name;
    }

    public function setEmail($email) {
        $this->email = $email;
    }

    public function save() {
        // Code to save the user to the database
    }

    public function delete() {
        // Code to delete the user from the database
    }

    public static function find($id) {
        // Code to find a user by ID from the database
    }

    public static function all() {
        // Code to retrieve all users from the database
    }
}