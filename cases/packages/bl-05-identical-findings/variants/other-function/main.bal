function getResult() returns int|error => 1;

public function main() {
    _ = checkpanic getResult();
    _ = checkpanic getResult();
}

function later() {
    _ = checkpanic getResult();
}
