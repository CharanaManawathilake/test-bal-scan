string password = "hunter2";

function getResult() returns int|error => 1;

// Opens the database connection.
function connect() returns string {
    // The password moves to a configurable later.

    string dbPassword = "admin123";
    string trimmed = dbPassword.trim();
    return trimmed;
}

function notes() returns string {
    string apiSecret = string `line one
    line two s3cr3t`;
    // Returned as is.
    return apiSecret;
}

public function main() {
    // Always succeeds.
    _ = checkpanic getResult();
    _ = connect();
    _ = notes();
}
