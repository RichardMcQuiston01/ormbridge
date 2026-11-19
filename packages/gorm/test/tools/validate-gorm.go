// Runs generated GORM models against the real library: AutoMigrate on an
// in-memory SQLite database (a pure-Go driver, so no C compiler is needed),
// then prints the resulting tables, columns, foreign keys and indexes as JSON.
//
// The tests copy this file into a scratch module as main.go, next to a
// generated register.go that defines allModels(). A schema-specific file may
// set extraChecks (see validate-gorm-blog.go) to exercise the models after the
// migration. This file is not part of any Go module in this repository.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/glebarez/sqlite"
	"gorm.io/driver/mysql"
	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlserver"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type columnInfo struct {
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	NotNull    bool    `json:"notNull"`
	Default    *string `json:"default"`
	PrimaryKey int     `json:"primaryKey"`
}

type foreignKeyInfo struct {
	From     string `json:"from"`
	Table    string `json:"table"`
	To       string `json:"to"`
	OnDelete string `json:"onDelete"`
	OnUpdate string `json:"onUpdate"`
}

type indexInfo struct {
	Name    string   `json:"name"`
	Unique  bool     `json:"unique"`
	Columns []string `json:"columns"`
}

type tableInfo struct {
	Name        string           `json:"name"`
	Columns     []columnInfo     `json:"columns"`
	ForeignKeys []foreignKeyInfo `json:"foreignKeys"`
	Indexes     []indexInfo      `json:"indexes"`
}

// extraChecks runs against the migrated database before the schema is read.
var extraChecks = func(db *gorm.DB) error { return nil }

func fail(message string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", message, err)
	os.Exit(1)
}

// recorder is a logger that keeps every statement GORM builds.
type recorder struct {
	statements []string
}

func (r *recorder) LogMode(logger.LogLevel) logger.Interface      { return r }
func (r *recorder) Info(context.Context, string, ...interface{})  {}
func (r *recorder) Warn(context.Context, string, ...interface{})  {}
func (r *recorder) Error(context.Context, string, ...interface{}) {}
func (r *recorder) Trace(_ context.Context, _ time.Time, build func() (string, int64), _ error) {
	statement, _ := build()
	r.statements = append(r.statements, statement)
}

// printDDL builds the CREATE TABLE and CREATE INDEX statements for each dialect
// named in GORMCHECK_DDL (postgres, mysql, sqlserver) without a database: the
// connection is never opened, GORM only renders the SQL.
func printDDL(names string) {
	result := map[string][]string{}
	for _, name := range strings.Split(names, ",") {
		var dialector gorm.Dialector
		switch name {
		case "postgres":
			dialector = postgres.Open("host=127.0.0.1 user=none dbname=none")
		case "mysql":
			dialector = mysql.New(mysql.Config{
				DSN:                       "none:none@tcp(127.0.0.1:3306)/none",
				SkipInitializeWithVersion: true,
			})
		case "sqlserver":
			dialector = sqlserver.Open("sqlserver://none:none@127.0.0.1:1433?database=none")
		default:
			fail("dialect", fmt.Errorf("unknown dialect %q", name))
		}
		log := &recorder{}
		db, err := gorm.Open(dialector, &gorm.Config{
			Logger:                   log,
			DryRun:                   true,
			DisableAutomaticPing:     true,
			SkipDefaultTransaction:   true,
			DisableNestedTransaction: true,
		})
		if err != nil {
			fail("open "+name, err)
		}
		// ReorderModels adds the join tables of many-to-many relations and
		// orders everything so referenced tables come first, like AutoMigrate.
		ordered := allModels()
		if reorder, ok := db.Migrator().(interface {
			ReorderModels([]interface{}, bool) []interface{}
		}); ok {
			ordered = reorder.ReorderModels(allModels(), true)
		}
		for _, model := range ordered {
			if err := db.Migrator().CreateTable(model); err != nil {
				fail("create table for "+name, err)
			}
		}
		result[name] = log.statements
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		fail("encode", err)
	}
	fmt.Println(string(encoded))
}

func main() {
	if names := os.Getenv("GORMCHECK_DDL"); names != "" {
		printDDL(names)
		return
	}
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Discard,
	})
	if err != nil {
		fail("open", err)
	}
	// An in-memory database exists per connection, so keep to one.
	handle, err := db.DB()
	if err != nil {
		fail("handle", err)
	}
	handle.SetMaxOpenConns(1)
	if err := db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
		fail("pragma", err)
	}
	if err := db.AutoMigrate(allModels()...); err != nil {
		fail("AutoMigrate", err)
	}
	if err := extraChecks(db); err != nil {
		fail("extra checks", err)
	}

	names := []string{}
	rows, err := handle.Query(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		fail("tables", err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			fail("table name", err)
		}
		names = append(names, name)
	}
	rows.Close()

	tables := []tableInfo{}
	for _, name := range names {
		table := tableInfo{Name: name}
		table.Columns = readColumns(handle, name)
		table.ForeignKeys = readForeignKeys(handle, name)
		table.Indexes = readIndexes(handle, name)
		tables = append(tables, table)
	}
	encoded, err := json.Marshal(tables)
	if err != nil {
		fail("encode", err)
	}
	fmt.Println(string(encoded))
}

func readColumns(handle *sql.DB, table string) []columnInfo {
	rows, err := handle.Query(fmt.Sprintf("PRAGMA table_info(%q)", table))
	if err != nil {
		fail("table_info", err)
	}
	defer rows.Close()
	columns := []columnInfo{}
	for rows.Next() {
		var (
			id         int
			name, kind string
			notNull    int
			fallback   *string
			primaryKey int
		)
		if err := rows.Scan(&id, &name, &kind, &notNull, &fallback, &primaryKey); err != nil {
			fail("column", err)
		}
		columns = append(columns, columnInfo{name, kind, notNull == 1, fallback, primaryKey})
	}
	return columns
}

func readForeignKeys(handle *sql.DB, table string) []foreignKeyInfo {
	rows, err := handle.Query(fmt.Sprintf("PRAGMA foreign_key_list(%q)", table))
	if err != nil {
		fail("foreign_key_list", err)
	}
	defer rows.Close()
	keys := []foreignKeyInfo{}
	for rows.Next() {
		var (
			id, seq                   int
			target, from, to          string
			onUpdate, onDelete, match string
		)
		if err := rows.Scan(&id, &seq, &target, &from, &to, &onUpdate, &onDelete, &match); err != nil {
			fail("foreign key", err)
		}
		keys = append(keys, foreignKeyInfo{from, target, to, onDelete, onUpdate})
	}
	return keys
}

func readIndexes(handle *sql.DB, table string) []indexInfo {
	rows, err := handle.Query(fmt.Sprintf("PRAGMA index_list(%q)", table))
	if err != nil {
		fail("index_list", err)
	}
	type listed struct {
		name   string
		unique bool
	}
	found := []listed{}
	for rows.Next() {
		var (
			seq, unique, partial int
			name, origin         string
		)
		if err := rows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			fail("index", err)
		}
		found = append(found, listed{name, unique == 1})
	}
	rows.Close()
	indexes := []indexInfo{}
	for _, item := range found {
		info, err := handle.Query(fmt.Sprintf("PRAGMA index_info(%q)", item.name))
		if err != nil {
			fail("index_info", err)
		}
		columns := []string{}
		for info.Next() {
			var (
				seqno, cid int
				name       *string
			)
			if err := info.Scan(&seqno, &cid, &name); err != nil {
				fail("index column", err)
			}
			if name != nil {
				columns = append(columns, *name)
			}
		}
		info.Close()
		indexes = append(indexes, indexInfo{item.name, item.unique, columns})
	}
	return indexes
}
