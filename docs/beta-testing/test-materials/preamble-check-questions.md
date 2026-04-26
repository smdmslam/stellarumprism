## preamble questions

you › heres the idea tell me if you can assist with this:
we need to test Prism capabilities using each of the llm models we have at our disposal. 
we have already created the tests tasks which can be found in 

/Users/stevenmorales/Development/StellarumPrism/docs/beta-testing/test-materials/prism-llm-test-questions.26april.md

and the idea is to run prism with the llm chosen in this case ive already set prism to gpt 5.4, so we dont need to carryout that step.. we just need to run the tests...

and we need to save the tests to the folder here:

/Users/stevenmorales/Development/StellarumPrism/docs/beta-testing/test-results

the results go into an md file where the naming convention should be date.model.test name (we have to make up a test name, maybe diagnostic tests 26 april or something like that.)

the date should be set like 2026.04.26

do you have any questions? or forsee any problems. think you can help with this?

1 question is that the tests are indepth and the full testing with each model is fairly long.. im thinking that if you can link from 1 test to the next test that would be ideal either with a shall we proceed or just directly that would be great. otherwise im not sure how this is going to work

questions?


## preamble questions part 2

1. One file per model run. Use the filename you proposed: 2026.04.26.gpt-5.4.diagnostic-tests.md. We'll repeat the same name with a different model slug for each subsequent run (2026.04.26.kimi-k2.5.diagnostic-tests.md, etc.) so cross-model comparisons are a simple file diff.

2. Include everything. Per test, capture:
•  test number + title
•  the prompt as given
•  your full response (verbatim, no summarization)
•  tools called during the test, if any
•  timestamp (start + end)
•  a short self-evaluation: did you complete the task, partially complete it, or fail? one sentence why
•  a blank Tester comments: field I'll fill in afterward

Don't grade yourself pass/fail — that's my call. Just describe what happened.

3. Answer as the active model directly. You are the system under test. Don't roleplay an external administrator; do the work, use your tools, and we record what happened. That's the whole point of this eval.

4. Stop after each test. End every test with the literal line Proceed to next test? (y / skip / stop) so I can:
•  y → continue to next
•  skip → log this one as skipped and move on
•  stop → end the run cleanly and finalize the file

## preamble part 3

Option 2. Re-read the file and count from scratch. Don't trust the breakdown
either — it might also be wrong. I want one number that comes from actually
counting prompts in the source, not from arithmetic on numbers you produced
earlier in this conversation.

Show me:
1. the verified total
2. the per-section breakdown that produced it (must sum to the total)
3. how you defined "a test" — is it every numbered item, every prompt-shaped
   line, every checkbox? Tell me the rule you used so I know the count is
   reproducible.

Then update the header in the results file with the verified number and
nothing else. Don't start Test 1.1 yet.

