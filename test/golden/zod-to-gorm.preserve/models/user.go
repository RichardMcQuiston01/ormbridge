package models

// User maps to the "User" table.
type User struct {
	ID int32 `gorm:"primaryKey;autoIncrement:false"`
}

// TableName overrides GORM's default table name (users).
func (User) TableName() string {
	return "User"
}
