function getResult() returns int|error => 1;

public function main() {
    // Non-compliant
    int result = checkpanic getResult();
}
