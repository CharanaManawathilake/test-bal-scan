// A standalone file.

function helper() returns int {
    return 1;
}

function getResult() returns int|error => 1;

public function main() {
    string password = "admin123";
    _ = checkpanic getResult();
    _ = password;
}
