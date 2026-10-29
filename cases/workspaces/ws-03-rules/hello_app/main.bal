import ballerina/io;
import playground/greeter_lib;

public function main() {
    string password = "p@ssw0rd";
    int x = 1;
    x = x;
    io:println(greeter_lib:greet("world", x));
    _ = password;
}
