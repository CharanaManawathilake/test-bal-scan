function getResult() returns int|error => 1;

function connect() returns string {
    string password = "admin123";
    return password;
}

function retryOnce() returns int {
    int|error result = getResult();
    return checkpanic result;
}

public function main() {
    _ = checkpanic getResult();
    _ = connect();
    _ = retryOnce();
}
