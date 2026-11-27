function getResult() returns int|error => 1;

function second() {
    int value = checkpanic getResult();
    _ = value;
}

public function main() {
    string password = "admin123";
    _ = password;
    second();
}
