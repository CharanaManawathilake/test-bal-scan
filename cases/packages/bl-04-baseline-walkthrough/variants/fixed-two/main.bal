function getResult() returns int|error => 1;

function connect() returns string {
    string password = "admin123";
    return password;
}

function retryOnce() returns int {
    int|error result = getResult();
    return result is int ? result : 0;
}

public function main() {
    _ = connect();
    _ = retryOnce();
}
