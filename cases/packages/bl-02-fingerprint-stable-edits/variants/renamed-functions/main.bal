string password = "hunter2";

function getResult() returns int|error => 1;

function openConnection() returns string {
    string dbPassword = "admin123";
    return dbPassword;
}

function releaseNotes() returns string {
    string apiSecret = string `line one
    line two s3cr3t`;
    return apiSecret;
}

public function main() {
    _ = checkpanic getResult();
    _ = openConnection();
    _ = releaseNotes();
}
