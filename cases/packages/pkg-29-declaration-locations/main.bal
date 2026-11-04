import ballerina/io;
import ballerina/jballerina.java;

type Meta record {|
    string note;
|};

annotation Meta Info on parameter, field;

# Returns the first value.
#
# + first - the value returned
# + second - never read
# + return - the first value
function documented(int first, @Info {note: "unused"} int second) returns int { // ballerina:2 on `int second` only
    return first;
}

// No ballerina:2: an external function has no body to use its parameter in.
function hex(int value) returns handle = @java:Method {
    'class: "java.lang.Long",
    name: "toHexString"
} external;

class Holder {
    # A documented field
    private string documentedField = ""; // ballerina:11 on this line only
    @Info {note: "annotated"}
    private final string annotatedField = ""; // ballerina:11 on this line only
    private int used = 0;

    function get() returns int => self.used;
}

public function main() {
    Holder holder = new;
    io:println(documented(1, 2), holder.get(), java:toString(hex(255)));
}
