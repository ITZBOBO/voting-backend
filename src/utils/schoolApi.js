// Bypass self-signed or leaf certificate validation
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export async function verifySchoolStudent(identifier, password) {
  const apiURL = process.env.SCHOOL_API_URL || 'https://freshdev.run.edu.ng';
  const apiKey = process.env.SCHOOL_API_KEY || '@@@@@@@@@@';

  try {
    // 1. Call login endpoint
    const loginRes = await fetch(`${apiURL}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        matric: identifier,
        password: password,
      }),
    });

    if (!loginRes.ok) {
      return null;
    }

    const loginData = await loginRes.json();
    
    // Check for login failure payload (HTTP 200 with invalid credentials detail)
    if (loginData && loginData.detail && typeof loginData.detail === 'string') {
      if (loginData.detail.toLowerCase().includes('invalid')) {
        return null;
      }
    }

    // 2. Fetch student details
    return await fetchSchoolStudentDetails(identifier);
  } catch (err) {
    console.error('Error during school student authentication:', err);
    throw new Error('Could not connect to the school verification system. Please try again later.');
  }
}

export async function fetchSchoolStudentDetails(identifier) {
  const apiURL = process.env.SCHOOL_API_URL || 'https://freshdev.run.edu.ng';
  const apiKey = process.env.SCHOOL_API_KEY || '@@@@@@@@@@';

  try {
    const detailsRes = await fetch(
      `${apiURL}/api/v1/student/details?username=${encodeURIComponent(identifier.toUpperCase())}`,
      {
        headers: {
          'api-key': apiKey,
        },
      }
    );

    if (!detailsRes.ok) {
      console.error('Failed to fetch student details. Status:', detailsRes.status);
      return null;
    }

    const detailsData = await detailsRes.json();
    
    if (!detailsData || !detailsData.user_info || !detailsData.account_details) {
      console.error('Invalid student details response structure:', detailsData);
      return null;
    }

    const { user_info: userInfo, account_details: accountDetails } = detailsData;
    const extraData = detailsData.extra_data || {};

    const matricNo = (userInfo.username || identifier).toUpperCase();
    const fullName = [userInfo.firstname, userInfo.middlename, userInfo.lastname].filter(Boolean).join(' ');
    
    const level = accountDetails.level ? accountDetails.level.toString() : null;
    const department = accountDetails.department || 'General';
    const faculty = accountDetails.college || accountDetails.faculty || accountDetails.programme || null;
    const semester = accountDetails.semester || extraData.semester || null;

    return {
      matricNo,
      fullName,
      level,
      department,
      faculty,
      semester
    };
  } catch (err) {
    console.error('Error fetching school student details:', err);
    return null;
  }
}
