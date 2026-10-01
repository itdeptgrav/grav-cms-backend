const jwt=require("jsonwebtoken");
console.log(jwt.sign({id:"69f057f6c02292fc8d7f48f2",email:"ceo@grav.in",tv:124,role:"ceo",userType:"dept_user"},process.env.JWT_SECRET,{expiresIn:"1h"}));
