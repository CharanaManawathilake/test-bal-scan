string password = "hunter2";

function getResult() returns int|error => 1;

public function main() {
    _ = checkpanic getResult(); _ = checkpanic getResult();
    taskOne();
    taskTwo();
}

function taskOne() {
    _ = checkpanic getResult();
}

function taskTwo() {
    _ = checkpanic getResult();
}
