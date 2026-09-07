package main

import _ "embed"

//go:embed migrations/001_initial.sql
var migrationSQL string
