package extras.keys;

import jakarta.persistence.Embeddable;
import java.io.Serializable;

@Embeddable
public class EnrollmentId implements Serializable {
  private Long studentId;
  private Long courseId;
}
