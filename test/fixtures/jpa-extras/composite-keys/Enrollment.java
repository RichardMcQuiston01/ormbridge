package extras.keys;

import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.MapsId;

@Entity
public class Enrollment {
  @EmbeddedId private EnrollmentId id;

  @MapsId("studentId")
  @ManyToOne(optional = false)
  private Student student;

  @MapsId("courseId")
  @ManyToOne(optional = false)
  private Course course;

  private Integer grade;
}
