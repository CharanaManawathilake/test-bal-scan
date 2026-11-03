// 2 LOW issues
function getResult() returns int|error => 1;

public function main() {
    int first = checkpanic getResult();
    int second = checkpanic getResult();
}
