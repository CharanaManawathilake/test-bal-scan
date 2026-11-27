string password = "hunter2"; // TODO: read from a configurable

function getResult() returns int|error => 1;

function connect() returns string {
    string dbPassword = "admin123"; // rotated every quarter
    return dbPassword;
}

function notes() returns string {
    string apiSecret = string `line one
    line two s3cr3t`;
    return apiSecret;
}

public function main() {
    _ = checkpanic getResult(); // always succeeds
    _ = connect();
    _ = notes();
}
