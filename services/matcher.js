const { OpenAI } = require('openai');
require('dotenv').config();

const client = new OpenAI({
    baseURL: 'https://integrate.api.nvidia.com/v1',
    apiKey: process.env.NVIDIA_API_KEY
});

const TARGET_ROLE = "Full Stack / Mobile Developer";
const RESUME_TEXT = `
Experienced Software Engineer highlighting Node.js, Spring Boot, and Flutter experience.
Proficient in building scalable backend services with Express.js and Spring Boot.
Strong frontend and mobile development skills using Flutter.
Familiar with RESTful APIs, database design (SQL/NoSQL), and cloud deployments.
`;

async function matchJob(jobDescription) {
    const systemPrompt = `You are an expert technical recruiter. Analyze the job requirements against the candidate's stack and output ONLY a strict JSON object containing:
- "score": an integer from 0 to 100 based on the fit.
- "reason": a one-sentence justification highlighting the strongest overlapping skills or missing gaps.

Candidate Target Role: ${TARGET_ROLE}
Candidate Resume:
${RESUME_TEXT}`;

    const userMessage = `Here is the Job Description:
${jobDescription}`;

    try {
        const completion = await client.chat.completions.create({
            model: "meta/llama-3.3-70b-instruct",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
            temperature: 0.2,
            response_format: { type: "json_object" }
        });

        const responseContent = completion.choices[0].message.content;
        return JSON.parse(responseContent);
    } catch (error) {
        console.error("Error matching job:", error.message);
        return { score: 0, reason: "Error generating match score." };
    }
}

module.exports = {
    matchJob
};