function getResult() returns int|error => 1;

public function main() {
    int result = checkpanic getResult(); // ballerina:1
    _ = result;
}
