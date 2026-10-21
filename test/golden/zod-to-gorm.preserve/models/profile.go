package models

// Profile maps to the "Profile" table.
type Profile struct {
	ID     int32   `gorm:"primaryKey;autoIncrement:false"`
	Bio    *string `gorm:"type:text"`
	Avatar *string `gorm:"size:100"`
	UserID int32   `gorm:"not null"`
}

// TableName overrides GORM's default table name (profiles).
func (Profile) TableName() string {
	return "Profile"
}
