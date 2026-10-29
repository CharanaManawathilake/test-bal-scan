import ballerina/scan;

public function main() {
    @scan:Suppress {rules: ["ballerina:998", "ballerina:999"]}
    int value = checkpanic int:fromString("1");
    _ = value;
}
